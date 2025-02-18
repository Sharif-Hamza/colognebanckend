// ES Module imports
import express from 'express';
import cors from 'cors';
import { config } from 'dotenv';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

// Load environment variables
config();

// Log environment variables (safely)
console.log('Environment variables check:', {
  SUPABASE_URL_SET: !!process.env.SUPABASE_URL,
  SUPABASE_URL_LENGTH: process.env.SUPABASE_URL?.length,
  SUPABASE_SERVICE_ROLE_KEY_SET: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_SERVICE_ROLE_KEY_LENGTH: process.env.SUPABASE_SERVICE_ROLE_KEY?.length,
  SUPABASE_ANON_KEY_SET: !!process.env.SUPABASE_ANON_KEY,
  SUPABASE_ANON_KEY_LENGTH: process.env.SUPABASE_ANON_KEY?.length,
  STRIPE_SECRET_KEY_SET: !!process.env.STRIPE_SECRET_KEY,
  STRIPE_SECRET_KEY_LENGTH: process.env.STRIPE_SECRET_KEY?.length,
  STRIPE_WEBHOOK_SECRET_SET: !!process.env.STRIPE_WEBHOOK_SECRET,
  STRIPE_WEBHOOK_SECRET_LENGTH: process.env.STRIPE_WEBHOOK_SECRET?.length,
  NODE_ENV: process.env.NODE_ENV
});

// Initialize Supabase client
console.log('Initializing Supabase Admin client with URL:', process.env.SUPABASE_URL);
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

// Initialize Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2023-10-16',
});

const app = express();

// CORS configuration
const corsOptions = {
  origin: function(origin, callback) {
    const allowedOrigins = [
      'http://localhost:5175',
      'https://cologne-ecommerce.netlify.app'
    ];
    
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) {
      return callback(null, true);
    }
    
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      console.log('Blocked by CORS:', origin);
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'OPTIONS', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'stripe-signature'],
  credentials: true,
  preflightContinue: false,
  optionsSuccessStatus: 204
};

app.use(cors(corsOptions));

// Middleware to parse JSON bodies
app.use((req, res, next) => {
  if (req.path === '/.netlify/functions/stripe-webhook') {
    // Use raw body for Stripe webhook
    express.raw({ type: 'application/json' })(req, res, next);
  } else {
    // Use JSON parser for all other routes
    express.json()(req, res, next);
  }
});

// Middleware to log requests
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`, {
    origin: req.headers.origin,
    contentType: req.headers['content-type'],
    authorization: req.headers.authorization ? 'present' : 'missing'
  });
  next();
});

// Test Supabase connection
async function testSupabaseConnection() {
  try {
    console.log('Testing Supabase connection with URL:', process.env.SUPABASE_URL);
    console.log('Service Role Key length:', process.env.SUPABASE_SERVICE_ROLE_KEY?.length);

    // Test auth admin capabilities
    const { data: { users }, error: authError } = await supabase.auth.admin.listUsers();
    if (authError) throw authError;

    console.log('Supabase auth admin test successful:', {
      usersCount: users.length,
      timestamp: new Date().toISOString()
    });

    // Test database query
    const { data, error: dbError } = await supabase
      .from('products')
      .select('id')
      .limit(1);

    if (dbError) throw dbError;

    console.log('Supabase database test successful:', {
      dataPresent: !!data,
      recordCount: data?.length,
      timestamp: new Date().toISOString()
    });

    console.log('Supabase connection test completed successfully');
  } catch (error) {
    console.error('Supabase connection test failed:', error);
    throw error;
  }
}

// Verify auth token middleware
async function verifyAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({ error: 'No authorization header' });
  }

  try {
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error) throw error;
    if (!user) throw new Error('User not found');

    req.user = user;
    next();
  } catch (error) {
    console.error('Auth error:', error);
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ status: 'healthy', environment: process.env.NODE_ENV });
});

// Create Stripe checkout session
app.post('/api/create-checkout-session', verifyAuth, async (req, res) => {
  try {
    const { line_items, success_url, cancel_url } = req.body;

    if (!line_items?.length) {
      return res.status(400).json({ error: 'No items in cart' });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items,
      success_url,
      cancel_url,
      metadata: {
        user_id: req.user.id
      }
    });

    res.json({ url: session.url, sessionId: session.id });
  } catch (error) {
    console.error('Checkout error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Stripe webhook endpoint
app.post('/.netlify/functions/stripe-webhook', async (req, res) => {
  try {
    const sig = req.headers['stripe-signature'];
    if (!sig) throw new Error('No Stripe signature found');

    const event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const userId = session.metadata?.user_id;

      if (!userId) {
        throw new Error('No user ID in session metadata');
      }

      // Create order record
      const { data: order, error: orderError } = await supabase
        .from('orders')
        .insert({
          user_id: userId,
          status: 'processing',
          total: session.amount_total / 100,
          subtotal: session.amount_subtotal / 100,
          tax_amount: session.total_details?.amount_tax ? session.total_details.amount_tax / 100 : 0,
          shipping_cost: session.total_details?.amount_shipping ? session.total_details.amount_shipping / 100 : 0,
          stripe_session_id: session.id
        })
        .select()
        .single();

      if (orderError) throw orderError;

      // Get line items
      const lineItems = await stripe.checkout.sessions.listLineItems(session.id, {
        expand: ['data.price.product']
      });

      // Create order items
      const orderItems = lineItems.data.map(item => {
        const product = item.price?.product;
        return {
          order_id: order.id,
          product_id: product.metadata.product_id,
          quantity: item.quantity,
          price_at_time: item.price.unit_amount / 100
        };
      });

      const { error: itemsError } = await supabase
        .from('order_items')
        .insert(orderItems);

      if (itemsError) throw itemsError;

      // Clear cart
      const { data: cart } = await supabase
        .from('carts')
        .select('id')
        .eq('user_id', userId)
        .single();

      if (cart) {
        await supabase
          .from('cart_items')
          .delete()
          .eq('cart_id', cart.id);
      }
    }

    res.json({ received: true });
  } catch (error) {
    console.error('Webhook error:', error);
    return res.status(400).json({ error: error.message });
  }
});

// Start server
const port = process.env.PORT || 3000;
app.listen(port, async () => {
  try {
    await testSupabaseConnection();
    console.log(`Server running on port ${port} in ${process.env.NODE_ENV} mode`);
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
});
