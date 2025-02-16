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
  NODE_ENV: process.env.NODE_ENV
});

// Initialize Express app
const app = express();

// Initialize Stripe with error handling
if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error('STRIPE_SECRET_KEY is not set');
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

// Initialize Supabase Admin client
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

// Test Supabase connection
supabaseAdmin
  .from('profiles')
  .select('count', { count: 'exact', head: true })
  .then(({ count, error }) => {
    if (error) {
      console.error('Supabase connection test failed:', error);
    } else {
      console.log('Supabase connection test successful. Profile count:', count);
    }
  })
  .catch(error => {
    console.error('Unexpected error testing Supabase connection:', error);
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
app.use(cors({
  origin: ['http://localhost:5173', 'http://localhost:5174', 'https://celebrated-hotteok-98d8df.netlify.app'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

// Parse JSON bodies
app.use((req, res, next) => {
  if (req.path === '/api/webhook') {
    next();
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

      console.log('Attempting to create profile with data:', {
        ...profileData,
        email: profileData.email.substring(0, 3) + '...' // Log partial email for privacy
      });

      const { data: newProfile, error: createError } = await supabaseAdmin
        .from('profiles')
        .insert(profileData)
        .select()
        .single();

      if (createError) {
        console.error('Profile creation error:', createError);
        console.error('Error details:', {
          error: createError,
          code: createError.code,
          message: createError.message,
          details: createError.details,
          hint: createError.hint,
          userId: user.id,
          userEmail: user.email.substring(0, 3) + '...',
          userMetadata: user.user_metadata
        });
        return res.status(500).json({ 
          error: 'Failed to create user profile',
          details: createError.message,
          code: createError.code
        });
      }

      profile = newProfile;
      console.log('Profile created successfully:', {
        id: profile.id,
        email: profile.email.substring(0, 3) + '...',
        created_at: profile.created_at
      });
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
app.post('/api/create-checkout-session', verifyAuth, async (req, res) => {
  try {
    const { line_items, success_url, cancel_url } = req.body;

    if (!line_items?.length) {
      return res.status(400).json({ error: 'No items in cart' });
    }

    // Create Stripe checkout session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items,
      success_url,
      cancel_url,
      customer_email: req.user.email,
      metadata: {
        user_id: req.user.id
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
      ]
    });

    // Create order in Supabase
    const { error: orderError } = await supabaseAdmin
      .from('orders')
      .insert({
        user_id: req.user.id,
        stripe_session_id: session.id,
        status: 'pending',
        total: session.amount_total / 100
      });

    if (orderError) {
      console.error('Order creation error:', orderError);
      return res.status(500).json({ 
        error: 'Failed to create order',
        details: orderError.message
      });
    }

    res.json({ sessionId: session.id });
  } catch (error) {
    console.error('Checkout error:', error);
    res.status(500).json({ 
      error: 'Checkout failed',
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
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      
      // Update order status
      const { error: updateError } = await supabaseAdmin
        .from('orders')
        .update({
          status: 'completed',
          payment_status: session.payment_status,
          shipping_details: session.shipping_details,
          payment_intent: session.payment_intent,
          updated_at: new Date().toISOString()
        })
        .eq('stripe_session_id', session.id);

      if (updateError) {
        console.error('Order update error:', updateError);
        return res.status(500).json({ error: 'Failed to update order' });
      }

      // Clear cart
      const { error: cartError } = await supabaseAdmin
        .from('cart_items')
        .delete()
        .eq('user_id', session.metadata.user_id);

      if (cartError) {
        console.error('Cart clear error:', cartError);
        // Don't return error here, as the order is already updated
      }
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
    environment: process.env.NODE_ENV,
    stripe: process.env.STRIPE_SECRET_KEY ? 'configured' : 'missing',
    supabase: process.env.SUPABASE_URL ? 'configured' : 'missing'
  });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
