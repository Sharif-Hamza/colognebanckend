import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

// Load environment variables
dotenv.config();

// Initialize Express app
const app = express();

// Log environment variables (excluding sensitive data)
console.log('Environment Check:', {
  SUPABASE_URL: process.env.SUPABASE_URL ? 'Set' : 'Not Set',
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ? 'Set' : 'Not Set',
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY ? 'Set' : 'Not Set',
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET ? 'Set' : 'Not Set',
  NODE_ENV: process.env.NODE_ENV,
});

// Initialize Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Initialize Supabase client with service role key
console.log('Initializing Supabase with:', {
  url_length: process.env.SUPABASE_URL?.length || 0,
  service_key_length: process.env.SUPABASE_SERVICE_ROLE_KEY?.length || 0,
  anon_key_length: process.env.SUPABASE_ANON_KEY?.length || 0
});

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing required Supabase configuration');
  process.exit(1);
}

const supabase = createClient(
  supabaseUrl,
  supabaseKey,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false
    }
  }
);

// Test Supabase connection and log more details
supabase.auth.getSession().then(({ data, error }) => {
  if (error) {
    console.error('Supabase connection test failed:', error);
    console.error('Current configuration:', {
      url_prefix: supabaseUrl.substring(0, 10) + '...',
      key_prefix: supabaseKey.substring(0, 10) + '...',
      key_length: supabaseKey.length
    });
  } else {
    console.log('Supabase connection test successful');
  }
});

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
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    supabase_url: process.env.SUPABASE_URL ? 'configured' : 'missing',
    stripe: process.env.STRIPE_SECRET_KEY ? 'configured' : 'missing'
  });
});

// Verify Supabase token middleware
async function verifyAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      console.error('No authorization header provided');
      return res.status(401).json({ error: 'Authentication required' });
    }

    const token = authHeader.replace('Bearer ', '');
    if (!token) {
      console.error('No token provided in authorization header');
      return res.status(401).json({ error: 'Authentication token required' });
    }

    console.log('Attempting to verify token...');
    
    // First try to decode the JWT to get the user ID
    try {
      const decoded = JSON.parse(atob(token.split('.')[1]));
      console.log('JWT decode successful:', { sub: decoded.sub });
      
      if (!decoded.sub) {
        console.error('No user ID in JWT');
        return res.status(401).json({ error: 'Invalid token format' });
      }

      // Get user profile directly using service role
      const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', decoded.sub)
        .single();

      if (profileError) {
        console.error('Profile fetch error:', profileError);
        console.error('Full error:', JSON.stringify(profileError, null, 2));
        return res.status(401).json({ 
          error: 'Failed to fetch user profile',
          details: profileError.message
        });
      }

      if (!profile) {
        console.error('No profile found for user:', decoded.sub);
        return res.status(401).json({ 
          error: 'User profile not found',
          details: 'Please ensure you have completed your profile setup'
        });
      }

      console.log('Profile found via JWT:', { id: profile.id });
      req.user = { 
        id: decoded.sub, 
        email: profile.email, 
        profile,
        auth_method: 'jwt'
      };
      return next();
    } catch (e) {
      console.error('JWT decode error:', e);
      // Continue to try Supabase auth if JWT fails
    }

    // If JWT decode fails, try Supabase auth
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);

    if (authError) {
      console.error('Token verification error:', authError);
      return res.status(401).json({ 
        error: 'Invalid authentication token',
        details: authError.message
      });
    }

    if (!user) {
      console.error('No user found from token');
      return res.status(401).json({ 
        error: 'User not found',
        details: 'Please sign in again'
      });
    }

    console.log('User found from token:', { id: user.id });

    // Get user profile
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single();

    if (profileError) {
      console.error('Profile fetch error:', profileError);
      return res.status(401).json({ 
        error: 'Failed to fetch user profile',
        details: profileError.message
      });
    }

    if (!profile) {
      console.error('No profile found for user:', user.id);
      return res.status(401).json({ 
        error: 'User profile not found',
        details: 'Please complete your profile setup'
      });
    }

    console.log('Profile found:', { id: profile.id });

    // Store user in request for later use
    req.user = { 
      ...user, 
      profile,
      auth_method: 'supabase'
    };
    next();
  } catch (error) {
    console.error('Auth error:', error);
    return res.status(401).json({ 
      error: 'Authentication failed', 
      details: error.message 
    });
  }
}

// Create checkout session endpoint
app.post('/api/create-checkout-session', verifyAuth, async (req, res) => {
  try {
    const { line_items, success_url, cancel_url, customer_email, user_id } = req.body;

    // Validate required fields
    if (!line_items || !Array.isArray(line_items) || line_items.length === 0) {
      return res.status(400).json({ error: 'Invalid or empty line items' });
    }

    if (!success_url || !cancel_url) {
      return res.status(400).json({ error: 'Missing success or cancel URLs' });
    }

    if (!customer_email || !user_id) {
      return res.status(400).json({ error: 'Missing customer information' });
    }

    // User is already verified in middleware, just check if IDs match
    if (req.user.id !== user_id) {
      console.error('User ID mismatch:', { 
        requestUserId: user_id, 
        tokenUserId: req.user.id 
      });
      return res.status(401).json({ 
        error: 'User ID mismatch',
        details: 'The provided user ID does not match the authenticated user'
      });
    }

    console.log('Creating Stripe checkout session for user:', user_id);

    // Create Stripe checkout session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items,
      success_url,
      cancel_url,
      customer_email,
      metadata: {
        user_id: user_id,
        auth_method: req.user.auth_method
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

    console.log('Checkout session created:', { sessionId: session.id });
    res.json({ sessionId: session.id });
  } catch (error) {
    console.error('Error creating checkout session:', error);
    res.status(500).json({ 
      error: 'Failed to create checkout session',
      details: error.message
    });
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
