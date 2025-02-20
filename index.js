// ES Module imports
import { default as express } from 'express';
import { default as cors } from 'cors';
import { config } from 'dotenv';
import { default as Stripe } from 'stripe';
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

// Initialize Express app
const app = express();

// Initialize Stripe with error handling
if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error('STRIPE_SECRET_KEY is not set');
}

if (!process.env.STRIPE_WEBHOOK_SECRET) {
  throw new Error('STRIPE_WEBHOOK_SECRET is not set');
}

// Initialize Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2023-10-16'
});

// Validate Supabase configuration
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_URL.includes('supabase.co')) {
  throw new Error('Invalid or missing SUPABASE_URL');
}

if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.SUPABASE_SERVICE_ROLE_KEY.includes('.')) {
  throw new Error('Invalid or missing SUPABASE_SERVICE_ROLE_KEY');
}

if (!process.env.SUPABASE_ANON_KEY || !process.env.SUPABASE_ANON_KEY.includes('.')) {
  throw new Error('Invalid or missing SUPABASE_ANON_KEY');
}

// Initialize Supabase Admin client with better error handling
console.log('Initializing Supabase Admin client with URL:', process.env.SUPABASE_URL);

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

// Test Supabase connection with detailed error logging
async function testSupabaseConnection() {
  try {
    console.log('Testing Supabase connection with URL:', process.env.SUPABASE_URL);
    console.log('Service Role Key length:', process.env.SUPABASE_SERVICE_ROLE_KEY?.length);
    
    // First test auth capabilities
    const { data: { users }, error: listUsersError } = await supabaseAdmin.auth.admin.listUsers();
    
    if (listUsersError) {
      console.error('Supabase auth admin test failed:', {
        error: listUsersError,
        message: listUsersError.message,
        details: listUsersError.details,
        hint: listUsersError.hint,
        status: listUsersError.status
      });
    } else {
      console.log('Supabase auth admin test successful:', {
        usersCount: users?.length,
        timestamp: new Date().toISOString()
      });
    }

    // Then test database
    const { data, error: dbError } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .limit(1);

    if (dbError) {
      console.error('Supabase database test failed:', {
        error: dbError,
        message: dbError.message,
        code: dbError.code,
        details: dbError.details,
        hint: dbError.hint
      });
      throw dbError;
    }

    console.log('Supabase database test successful:', {
      dataPresent: !!data,
      recordCount: data?.length,
      timestamp: new Date().toISOString()
    });
    return true;
  } catch (error) {
    console.error('Unexpected error testing Supabase connection:', {
      error: error.message,
      name: error.name,
      stack: error.stack,
      timestamp: new Date().toISOString()
    });
    return false;
  }
}

// Run the connection test immediately
testSupabaseConnection().then(success => {
  if (!success) {
    console.error('Supabase connection test failed - check credentials and network connectivity');
  } else {
    console.log('Supabase connection test completed successfully');
  }
});

// Initialize Supabase Auth client
const supabaseAuth = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

// CORS configuration
const corsOptions = {
  origin: function(origin, callback) {
    const allowedOrigins = process.env.CORS_ORIGIN ? 
      process.env.CORS_ORIGIN.split(',') : 
      ['http://localhost:5175', 'https://celebrated-hotteok-98d8df.netlify.app'];
    
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      console.log('Origin not allowed by CORS:', origin);
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'stripe-signature'],
  exposedHeaders: ['Access-Control-Allow-Origin'],
  credentials: true,
  maxAge: 86400, // 24 hours
  preflightContinue: false,
  optionsSuccessStatus: 204
};

// Apply CORS middleware
app.use(cors(corsOptions));

// Remove the additional CORS headers middleware since it's redundant
app.use(express.json());

// Parse JSON bodies (except for Stripe webhook)
app.use((req, res, next) => {
  if (req.path === '/api/webhook') {
    express.raw({ type: 'application/json' })(req, res, next);
  } else {
    express.json()(req, res, next);
  }
});

// Verify auth middleware
async function verifyAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: 'No authorization header' });
    }

    const token = authHeader.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    // Verify token with Supabase Auth
    const { data: { user }, error: authError } = await supabaseAuth.auth.getUser(token);

    if (authError || !user) {
      console.error('Auth error:', authError);
      return res.status(401).json({ 
        error: 'Invalid authentication token',
        details: authError?.message
      });
    }

    // Get user profile
    let { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single();

    // If profile doesn't exist, create it
    if (!profile) {
      console.log('Creating profile for user:', user.id);
      
      const profileData = {
        id: user.id,
        email: user.email,
        full_name: user.user_metadata?.full_name || '',
        shipping_address: user.user_metadata?.shipping_address || null,
        created_at: new Date().toISOString()
      };

      try {
        // First, disable RLS for this operation
        await supabaseAdmin.rpc('disable_rls');

        const { data: newProfile, error: createError } = await supabaseAdmin
          .from('profiles')
          .insert(profileData)
          .select()
          .single();

        // Re-enable RLS
        await supabaseAdmin.rpc('enable_rls');

        if (createError) {
          console.error('Profile creation error:', createError);
          return res.status(500).json({ 
            error: 'Failed to create user profile',
            details: createError.message
          });
        }
        profile = newProfile;
      } catch (error) {
        console.error('Unexpected error during profile creation:', error);
        return res.status(500).json({ 
          error: 'Failed to create user profile',
          details: error.message
        });
      }
    }

    req.user = {
      id: user.id,
      email: user.email,
      profile
    };

    next();
  } catch (error) {
    console.error('Auth error:', error);
    res.status(401).json({ 
      error: 'Authentication failed',
      details: error.message
    });
  }
}

// Create checkout session endpoint
app.post('/create-checkout-session', verifyAuth, async (req, res) => {
  try {
    const { line_items, success_url, cancel_url } = req.body;

    if (!line_items?.length) {
      return res.status(400).json({ error: 'No items in cart' });
    }

    // Validate line items
    for (const item of line_items) {
      if (!item.price_data?.product_data?.metadata?.product_id) {
        return res.status(400).json({ 
          error: 'Invalid line item',
          details: 'Each line item must include product_id in metadata'
        });
      }
    }

    console.log('Creating checkout session for user:', {
      userId: req.user.id,
      email: req.user.email.substring(0, 3) + '...',
      itemCount: line_items.length,
      items: line_items.map(item => ({
        product_id: item.price_data.product_data.metadata.product_id,
        quantity: item.quantity
      }))
    });

    // Create Stripe checkout session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items,
      success_url: success_url || `${req.headers.origin}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancel_url || `${req.headers.origin}/cart`,
      customer_email: req.user.email,
      metadata: {
        user_id: req.user.id,
        line_items: JSON.stringify(line_items)
      },
      shipping_address_collection: {
        allowed_countries: ['US', 'CA', 'GB'],
      },
      shipping_options: [
        {
          shipping_rate_data: {
            type: 'fixed_amount',
            fixed_amount: { amount: 0, currency: 'usd' },
            display_name: 'Free shipping',
            delivery_estimate: {
              minimum: { unit: 'business_day', value: 5 },
              maximum: { unit: 'business_day', value: 7 },
            },
          },
        }
      ],
      allow_promotion_codes: true,
      billing_address_collection: 'required',
      submit_type: 'pay',
      payment_intent_data: {
        capture_method: 'automatic',
        metadata: {
          user_id: req.user.id
        }
      }
    });

    console.log('Stripe session created:', {
      sessionId: session.id,
      amount: session.amount_total,
      url: session.url,
      metadata: session.metadata
    });

    res.json({ 
      sessionId: session.id,
      url: session.url
    });
  } catch (error) {
    console.error('Checkout error:', {
      message: error.message,
      type: error.type,
      code: error.code,
      param: error.param,
      detail: error.detail
    });
    res.status(500).json({ 
      error: 'Checkout failed',
      details: error.message
    });
  }
});

// Webhook endpoint
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      
      console.log('Processing completed checkout session:', {
        sessionId: session.id,
        userId: session.metadata.user_id,
        amount: session.amount_total,
        paymentStatus: session.payment_status
      });

      // Verify payment status
      if (session.payment_status !== 'paid') {
        console.log('Payment not completed, skipping order creation');
        return res.json({ received: true });
      }

      // Get line items from session metadata and parse
      let lineItems;
      try {
        lineItems = JSON.parse(session.metadata.line_items);
      } catch (error) {
        console.error('Error parsing line items:', error);
        return res.status(400).json({ error: 'Invalid line items data' });
      }

      // Create order in Supabase
      const orderData = {
        user_id: session.metadata.user_id,
        stripe_session_id: session.id,
        status: 'processing',
        total: session.amount_total / 100,
        subtotal: session.amount_subtotal / 100,
        tax_amount: session.total_details?.amount_tax ? session.total_details.amount_tax / 100 : 0,
        shipping_cost: session.total_details?.amount_shipping ? session.total_details.amount_shipping / 100 : 0,
        shipping_details: session.shipping_details,
        payment_status: session.payment_status,
        payment_intent: session.payment_intent,
        created_at: new Date().toISOString()
      };

      // Disable RLS for database operations
      await supabaseAdmin.rpc('disable_rls');

      // Create the order
      const { data: order, error: orderError } = await supabaseAdmin
        .from('orders')
        .insert([orderData])
        .select()
        .single();

      if (orderError) {
        console.error('Order creation error:', orderError);
        return res.status(500).json({ error: 'Failed to create order' });
      }

      // Create order items
      const orderItems = lineItems.map(item => ({
        order_id: order.id,
        product_id: item.price_data.product_data.metadata.product_id,
        quantity: item.quantity,
        price_at_time: item.price_data.unit_amount / 100
      }));

      const { error: itemsError } = await supabaseAdmin
        .from('order_items')
        .insert(orderItems);

      if (itemsError) {
        console.error('Error creating order items:', itemsError);
      }

      // Clear user's cart
      const { error: cartError } = await supabaseAdmin
        .from('cart_items')
        .delete()
        .eq('user_id', session.metadata.user_id);

      // Re-enable RLS
      await supabaseAdmin.rpc('enable_rls');

      if (cartError) {
        console.error('Error clearing cart:', cartError);
      }

      // Create order history entry
      const { error: historyError } = await supabaseAdmin
        .from('order_history')
        .insert({
          order_id: order.id,
          status: 'processing',
          notes: 'Order created via successful Stripe payment',
          created_by: session.metadata.user_id,
          created_at: new Date().toISOString()
        });

      if (historyError) {
        console.error('Error creating order history:', historyError);
      }

      console.log('Order created successfully:', {
        orderId: order.id,
        status: order.status,
        total: order.total,
        itemCount: orderItems.length
      });
    }

    res.json({ received: true });
  } catch (error) {
    console.error('Webhook processing error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'healthy',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV
  });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`Server running on port ${PORT} in ${process.env.NODE_ENV} mode`);
  console.log('CORS configuration:', {
    allowedOrigins: corsOptions.origin,
    methods: corsOptions.methods,
    allowedHeaders: corsOptions.allowedHeaders
  });
});
