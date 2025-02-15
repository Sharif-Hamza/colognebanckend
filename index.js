import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

// Load environment variables
dotenv.config();

// Initialize Express app
const app = express();

// Initialize Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Initialize Supabase client with service role key
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false
    }
  }
);

// CORS middleware with preflight support
app.use(cors({
  origin: '*', // Allow all origins in development
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  preflightContinue: false,
  optionsSuccessStatus: 204
}));

// Handle preflight requests
app.options('*', cors());

// Parse JSON bodies for all routes except webhook
app.use((req, res, next) => {
  if (req.path === '/api/webhook') {
    next();
  } else {
    express.json()(req, res, next);
  }
});

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Verify Supabase token middleware
async function verifyAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: 'No authorization header' });
    }

    const token = authHeader.replace('Bearer ', '');
    
    // Verify the JWT token with Supabase
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error) {
      console.error('Token verification error:', error);
      // Try to decode the JWT to get the user ID
      try {
        const decoded = JSON.parse(atob(token.split('.')[1]));
        if (decoded.sub) {
          // Get user profile directly
          const { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', decoded.sub)
            .single();

          if (profileError || !profile) {
            return res.status(401).json({ error: 'User profile not found' });
          }

          req.user = { id: decoded.sub, email: profile.email };
          return next();
        }
      } catch (e) {
        console.error('JWT decode error:', e);
      }
      return res.status(401).json({ error: 'Invalid authentication token' });
    }

    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    // Get user profile
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single();

    if (profileError || !profile) {
      return res.status(401).json({ error: 'User profile not found' });
    }

    // Store user in request for later use
    req.user = { ...user, profile };
    next();
  } catch (error) {
    console.error('Auth error:', error);
    return res.status(401).json({ error: 'Authentication failed', details: error.message });
  }
}

// Create checkout session endpoint
app.post('/api/create-checkout-session', verifyAuth, async (req, res) => {
  try {
    const { line_items, success_url, cancel_url, customer_email, user_id } = req.body;

    if (!line_items || !success_url || !cancel_url || !customer_email || !user_id) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // User is already verified in middleware, just check if IDs match
    if (req.user.id !== user_id) {
      return res.status(401).json({ error: 'User ID mismatch' });
    }

    // Create Stripe checkout session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items,
      success_url,
      cancel_url,
      customer_email,
      metadata: {
        user_id: user_id
      },
      shipping_address_collection: {
        allowed_countries: ['US', 'CA', 'GB'],
      },
      shipping_options: [
        {
          shipping_rate_data: {
            type: 'fixed_amount',
            fixed_amount: {
              amount: 0,
              currency: 'usd',
            },
            display_name: 'Free shipping',
            delivery_estimate: {
              minimum: {
                unit: 'business_day',
                value: 5,
              },
              maximum: {
                unit: 'business_day',
                value: 7,
              },
            },
          },
        }
      ],
      allow_promotion_codes: true,
      billing_address_collection: 'required',
    });

    res.json({ sessionId: session.id });
  } catch (error) {
    console.error('Error creating checkout session:', error);
    res.status(500).json({ error: error.message });
  }
});

// Webhook endpoint
app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook Error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.metadata.user_id;

    try {
      // Get cart
      const { data: cartData } = await supabase
        .from('carts')
        .select('id')
        .eq('user_id', userId)
        .single();

      if (!cartData?.id) {
        throw new Error('Cart not found');
      }

      // Get cart items
      const { data: cartItems, error: cartError } = await supabase
        .from('cart_items')
        .select(`
          product_id,
          quantity,
          products (
            name,
            price,
            image_url
          )
        `)
        .eq('cart_id', cartData.id);

      if (cartError) throw cartError;

      // Create order
      const { data: order, error: orderError } = await supabase
        .from('orders')
        .insert({
          user_id: userId,
          status: 'completed',
          total: session.amount_total / 100,
          stripe_session_id: session.id,
          shipping_address: session.shipping_details,
          payment_status: session.payment_status,
          fulfillment_status: 'pending'
        })
        .select()
        .single();

      if (orderError) throw orderError;

      // Create order items
      const orderItems = cartItems.map(item => ({
        order_id: order.id,
        product_id: item.product_id,
        quantity: item.quantity,
        price: item.products.price
      }));

      const { error: itemsError } = await supabase
        .from('order_items')
        .insert(orderItems);

      if (itemsError) throw itemsError;

      // Clear cart
      await supabase
        .from('cart_items')
        .delete()
        .eq('cart_id', cartData.id);

    } catch (error) {
      console.error('Error processing order:', error);
      return res.status(500).json({ error: 'Failed to process order' });
    }
  }

  res.json({ received: true });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
