import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

// Load environment variables
dotenv.config();

// Validate required environment variables
const requiredEnvVars = [
  'STRIPE_SECRET_KEY',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'CORS_ORIGIN'
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    throw new Error(`Missing required environment variable: ${envVar}`);
  }
}

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

// Middleware
app.use(express.json());
app.use(cors({
  origin: process.env.CORS_ORIGIN,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'healthy',
    supabase: !!supabase,
    stripe: !!stripe
  });
});

// Create checkout session
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { line_items, success_url, cancel_url, customer_email } = req.body;

    if (!line_items || !success_url || !cancel_url || !customer_email) {
      return res.status(400).json({ 
        error: 'Missing required fields' 
      });
    }

    // Get user from Supabase
    const { data: { user }, error: userError } = await supabase.auth.admin.getUserByEmail(
      customer_email
    );

    if (userError || !user) {
      return res.status(401).json({ error: 'User not found' });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items,
      success_url,
      cancel_url,
      customer_email,
      metadata: {
        user_id: user.id
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
    res.status(500).json({ 
      error: error.message || 'Failed to create checkout session' 
    });
  }
});

// Webhook endpoint for Stripe events
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

  // Handle the event
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.metadata.user_id;

    try {
      // Get cart items
      const { data: cartData } = await supabase
        .from('carts')
        .select('id')
        .eq('user_id', userId)
        .single();

      if (!cartData?.id) {
        throw new Error('Cart not found');
      }

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

      // Calculate total from cart items
      const total = cartItems.reduce((sum, item) => {
        return sum + (item.products.price * item.quantity);
      }, 0);

      // Create order
      const { data: order, error: orderError } = await supabase
        .from('orders')
        .insert({
          user_id: userId,
          status: 'completed',
          total: total,
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

      console.log('Order processed successfully:', order.id);
    } catch (error) {
      console.error('Error processing order:', error);
      return res.status(500).json({ error: 'Failed to process order' });
    }
  }

  res.json({ received: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log('Environment:', {
    supabaseUrl: process.env.SUPABASE_URL,
    hasServiceKey: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    corsOrigin: process.env.CORS_ORIGIN
  });
});
