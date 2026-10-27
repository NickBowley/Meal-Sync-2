import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import Stripe from 'stripe';
import {
  createFamilyAllAccessCheckoutSession,
  retrieveCheckoutSession,
  verifyAndConstructWebhookEvent,
} from './server/stripe';
import {
  updateUserSubscription,
  getUserSubscription,
  getAllSubscriptions,
  logWebhookEvent,
  getWebhookLogs,
} from './server/db';
import {
  buildIcsString,
  getFeedEvents,
  updateFeedEvents,
} from './server/calendarFeed';
import {
  getAllPersistedGroceryAccounts,
  upsertPersistedGroceryAccount,
  syncSkusToPersistedAccount,
} from './server/groceryAccounts';
import {
  getLiveTrolleyQueue,
  acknowledgeLiveTrolleyAutoStart,
  launchAndPushSainsburysLiveTrolley,
  getLiveWebViewState,
} from './server/sainsburysLiveTrolley';
import {
  SAMSUNG_FOOD_UK_RETAILERS,
  createSamsungFoodBasketHandoff,
  getSamsungFoodBatch,
  renderSamsungFoodCheckoutPageHtml,
} from './server/samsungFoodWhisk';
import fs from 'fs';

// Load environment variables (.env)
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isProduction = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT) || 3000;

// The frontend publishable key requested by user (configurable via env var)
const STRIPE_PUBLISHABLE_KEY =
  process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY ||
  process.env.STRIPE_PUBLISHABLE_KEY ||
  'pk_test_pk_live_51UUrCf4zcRf8LhgQF5LsWrrFd2wpw51X54trXw0FoEa9rwiMrNMGMQeSWmCUxLPIWnniB3IxssWICWg8Xr9Cptbg00XBXxtTdo';

async function startServer() {
  const app = express();

  // 1. STRIPE WEBHOOK LISTENER
  // CRITICAL: Mounted BEFORE express.json() with express.raw() to preserve raw Buffer
  // required for cryptographic signature verification (stripe.webhooks.constructEvent)
  app.post(
    '/api/stripe-webhook',
    express.raw({ type: 'application/json' }),
    async (req: Request, res: Response) => {
      const signature = req.headers['stripe-signature'];
      const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
      const rawBody = req.body;

      let event: Stripe.Event;

      try {
        if (!webhookSecret) {
          console.warn('⚠️ [Stripe Webhook] STRIPE_WEBHOOK_SECRET is not configured in server environment.');
          // In development/test mode, allow simulated trigger if explicit test header provided
          if (process.env.NODE_ENV !== 'production' && req.headers['x-bypass-verify'] === 'dev-simulation') {
            event = JSON.parse(rawBody.toString('utf-8')) as Stripe.Event;
          } else {
            logWebhookEvent('unverified', 'unknown_id', 'failed', {
              error: 'STRIPE_WEBHOOK_SECRET missing in server environment',
            });
            return res.status(400).json({
              error: 'WEBHOOK_SECRET_MISSING',
              message:
                'STRIPE_WEBHOOK_SECRET must be configured in your .env file to verify incoming Stripe webhook signatures.',
            });
          }
        } else {
          // Verify cryptographic signature to prevent spoofed requests
          event = verifyAndConstructWebhookEvent(rawBody, signature, webhookSecret);
        }
      } catch (err: any) {
        console.error(`❌ [Stripe Webhook Error] Signature verification failed: ${err.message}`);
        logWebhookEvent('signature_verification_failed', 'invalid_sig', 'failed', {
          error: err.message,
        });
        return res.status(400).send(`Webhook Signature Verification Error: ${err.message}`);
      }

      console.log(`🔔 [Stripe Webhook] Verified event received: ${event.type} [${event.id}]`);

      // Specifically handle the checkout.session.completed event
      if (event.type === 'checkout.session.completed') {
        const session = event.data.object as Stripe.Checkout.Session;

        // Extract client_reference_id (userId) and customer email from session object
        const userId =
          session.client_reference_id ||
          session.metadata?.userId ||
          (session.customer_details?.email
            ? `usr_${session.customer_details.email.replace(/[^a-zA-Z0-9]/g, '_')}`
            : 'usr_bowley_household');

        const customerEmail =
          session.customer_details?.email ||
          session.customer_email ||
          session.metadata?.customerEmail ||
          'bowleyn3@gmail.com';

        const stripeCustomerId =
          typeof session.customer === 'string'
            ? session.customer
            : session.customer?.id || 'cus_unknown';

        const subscriptionId =
          typeof session.subscription === 'string'
            ? session.subscription
            : session.subscription?.id;

        const tier = session.metadata?.tier || 'all_access_annual';
        const planName = session.metadata?.plan || 'Family All-Access Annual (£69.99/yr)';
        const familyName = session.metadata?.familyName || 'The Bowley Family';

        console.log(`💳 [Stripe Webhook] Extracted details for checkout.session.completed:`, {
          userId,
          customerEmail,
          stripeCustomerId,
          subscriptionId,
          tier,
        });

        // Update the user's document/record in the shared database (Firebase/Supabase)
        try {
          const record = await updateUserSubscription({
            userId,
            customerEmail,
            familyName,
            isProMember: true,
            stripeCustomerId,
            subscriptionId,
            tier,
            planName,
            status: 'active',
            source: 'stripe_webhook',
            rawSessionId: session.id,
          });

          logWebhookEvent(event.type, event.id, 'processed', {
            userId,
            customerEmail,
            stripeCustomerId,
            subscriptionId,
            isProMember: true,
            tier,
            recordId: record.userId,
          });

          console.log(`🎉 [Database Sync] User ${userId} (${customerEmail}) isProMember set to true.`);
        } catch (dbErr: any) {
          console.error('❌ Failed to update user in database:', dbErr);
          logWebhookEvent(event.type, event.id, 'failed', {
            error: dbErr.message,
            userId,
            customerEmail,
          });
          return res.status(500).json({ error: 'Database update failed' });
        }
      } else {
        // Acknowledge other events (e.g. customer.subscription.updated)
        logWebhookEvent(event.type, event.id, 'ignored', {
          note: `Event ${event.type} acknowledged without action.`,
        });
      }

      // Return a 200 OK response to Stripe upon successful processing
      return res.status(200).json({ received: true });
    }
  );

  // 2. PARSE JSON BODIES FOR STANDARD API ROUTES
  app.use(express.json());

  // API Route: Public Stripe Config & Webhook status
  app.get('/api/stripe-config', (_req: Request, res: Response) => {
    res.json({
      publishableKey: STRIPE_PUBLISHABLE_KEY,
      hasSecretKey: Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_SECRET_KEY.trim().length > 0),
      hasWebhookSecret: Boolean(process.env.STRIPE_WEBHOOK_SECRET && process.env.STRIPE_WEBHOOK_SECRET.trim().length > 0),
      hasPriceId: Boolean(process.env.STRIPE_ANNUAL_PRICE_ID && process.env.STRIPE_ANNUAL_PRICE_ID.trim().length > 0),
      planName: 'Family All-Access Annual Pass',
      price: '£69.99 / year',
      currency: 'gbp',
      trialDays: 7,
      webhookEndpoint: '/api/stripe-webhook',
    });
  });

  // API Route: Create Stripe Checkout Session for 3-Tier Plans (Meal Sync Plus or Family All-Access)
  app.post('/api/create-checkout-session', async (req: Request, res: Response) => {
    try {
      const { customerEmail, familyName, userId, withTrial, returnUrl, tier, billingInterval } = req.body || {};
      const selectedTier = tier === 'meal_sync_plus' ? 'meal_sync_plus' : 'all_access_annual';
      const selectedInterval = billingInterval === 'month' ? 'month' : 'year';

      const origin =
        returnUrl ||
        req.headers.origin ||
        req.headers.referer?.replace(/\/$/, '') ||
        process.env.APP_URL ||
        `http://localhost:${PORT}`;

      const cleanOrigin = origin.replace(/\/$/, '');
      const successUrl = `${cleanOrigin}/?checkout=success&tier=${selectedTier}&interval=${selectedInterval}&session_id={CHECKOUT_SESSION_ID}`;
      const cancelUrl = `${cleanOrigin}/?checkout=cancel`;

      const secretKey = process.env.STRIPE_SECRET_KEY?.trim();

      if (!secretKey) {
        return res.status(400).json({
          error: 'STRIPE_SECRET_KEY_MISSING',
          message:
            'STRIPE_SECRET_KEY is not configured in the server environment. Please define STRIPE_SECRET_KEY in your .env file.',
          publishableKey: STRIPE_PUBLISHABLE_KEY,
          fallbackUrl: `${cleanOrigin}/?checkout=success&tier=${selectedTier}&interval=${selectedInterval}&simulated=true`,
        });
      }

      const session = await createFamilyAllAccessCheckoutSession({
        successUrl,
        cancelUrl,
        customerEmail,
        familyName: familyName || 'The Bowley Family',
        userId,
        withTrial: Boolean(withTrial),
        tier: selectedTier,
        billingInterval: selectedInterval,
      });

      return res.json({
        url: session.url,
        sessionId: session.id,
        publishableKey: STRIPE_PUBLISHABLE_KEY,
      });
    } catch (error: any) {
      console.error('Error creating Stripe Checkout session:', error);
      return res.status(500).json({
        error: 'CHECKOUT_CREATION_FAILED',
        message: error?.message || 'Failed to create Stripe Checkout session',
      });
    }
  });

  // API Route: Verify Checkout Session
  app.get('/api/verify-session/:sessionId', async (req: Request, res: Response) => {
    try {
      const { sessionId } = req.params;
      if (!process.env.STRIPE_SECRET_KEY) {
        return res.json({
          verified: true,
          simulated: true,
          status: 'complete',
          tier: 'all_access_annual',
          price: '£69.99',
        });
      }

      const session = await retrieveCheckoutSession(sessionId);
      return res.json({
        verified: session.status === 'complete' || session.payment_status === 'paid',
        status: session.status,
        paymentStatus: session.payment_status,
        customerEmail: session.customer_details?.email,
        subscriptionId: typeof session.subscription === 'string' ? session.subscription : session.subscription?.id,
      });
    } catch (error: any) {
      return res.status(500).json({
        verified: false,
        error: error?.message || 'Failed to verify session',
      });
    }
  });

  // API Route: Database User Subscription Status lookup
  app.get('/api/subscription-status', (req: Request, res: Response) => {
    const idOrEmail = (req.query.userId || req.query.email || '') as string;
    if (!idOrEmail) {
      return res.json({ subscriptions: getAllSubscriptions() });
    }
    const record = getUserSubscription(idOrEmail);
    return res.json({
      found: Boolean(record),
      subscription: record || null,
    });
  });

  // API Route: Apple Calendar & Universal RFC 5545 iCalendar Subscription Feed
  app.get('/api/calendar/family-schedule.ics', (_req: Request, res: Response) => {
    const events = getFeedEvents();
    const icsContent = buildIcsString(events);
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="family-schedule.ics"');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    return res.send(icsContent);
  });

  // API Route: Update Calendar Subscription Feed from Frontend State
  app.post('/api/calendar/sync-feed', (req: Request, res: Response) => {
    const { events } = req.body || {};
    if (Array.isArray(events)) {
      updateFeedEvents(events);
      return res.json({ success: true, count: events.length });
    }
    return res.status(400).json({ error: 'Missing events array' });
  });

  // Enable CORS on /api/grocery-accounts* so content scripts & bookmarklets on sainsburys.co.uk can sync directly
  app.use('/api/grocery-accounts', (req: Request, res: Response, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }
    next();
  });

  // API Route: Get All Persisted Connected Supermarket Accounts & Active Sessions
  app.get('/api/grocery-accounts', (_req: Request, res: Response) => {
    const accounts = getAllPersistedGroceryAccounts();
    return res.json({
      success: true,
      accounts,
    });
  });

  // API Route: Get Live Trolley Auto-Adder Queue (consumed by Sainsbury's content script / bookmarklet)
  app.get('/api/grocery-accounts/live-queue', (req: Request, res: Response) => {
    const retailerId = String(req.query.retailerId || 'sainsburys');
    const queue = getLiveTrolleyQueue(retailerId);
    return res.json({
      success: true,
      ...queue,
    });
  });

  // API Route: Acknowledge Auto-Start Queue on sainsburys.co.uk
  app.post('/api/grocery-accounts/ack-queue', (req: Request, res: Response) => {
    const { retailerId } = req.body || {};
    acknowledgeLiveTrolleyAutoStart(retailerId || 'sainsburys');
    return res.json({ success: true });
  });

  // API Route: Launch Live Chrome Session & Push SKU List to Real Sainsbury's Trolley
  app.post('/api/grocery-accounts/live-trolley-push', async (req: Request, res: Response) => {
    try {
      const { retailerId, items, autoStart, accountEmail, accountPassword } = req.body || {};
      if (!Array.isArray(items)) {
        return res.status(400).json({ error: 'Missing items array' });
      }
      const result = await launchAndPushSainsburysLiveTrolley(
        retailerId || 'sainsburys',
        items,
        autoStart !== false,
        accountEmail,
        accountPassword
      );
      return res.json({
        success: true,
        ...result,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // API Route: Get Live In-App WebView State (URL, Login status, Trolley Total, Queue items, optional frame)
  app.get('/api/grocery-accounts/live-webview-state', async (req: Request, res: Response) => {
    try {
      const includeShot = req.query.screenshot === '1' || req.query.screenshot === 'true';
      const retailerId = req.query.retailerId ? String(req.query.retailerId) : undefined;
      const state = await getLiveWebViewState(includeShot, retailerId);
      return res.json({
        success: true,
        ...state,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // API Route: Serve self-contained Sainsbury's Live Auto-Adder JS for bookmarklet / userscript
  app.get('/api/grocery-accounts/sainsburys-loader.js', (_req: Request, res: Response) => {
    const scriptPath = path.resolve(__dirname, 'chrome-extension', 'sainsburys-sync', 'content.js');
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    if (fs.existsSync(scriptPath)) {
      return res.send(fs.readFileSync(scriptPath, 'utf-8'));
    }
    return res.send('console.warn("Meal Sync script not found");');
  });

  // API Route: Connect or Update a Supermarket Account (Issues Persistent Session & Refresh Token)
  app.post('/api/grocery-accounts/connect', (req: Request, res: Response) => {
    const {
      retailerId,
      name,
      accountEmail,
      accountPassword,
      loyaltyNumber,
      loyaltyCardName,
      preferredBranch,
      autoPrepopulate,
      keepSignedIn,
      status,
    } = req.body || {};

    if (!retailerId) {
      return res.status(400).json({ error: 'Missing retailerId' });
    }

    const updated = upsertPersistedGroceryAccount(retailerId, {
      name,
      status: status || 'connected',
      accountEmail,
      ...(accountPassword !== undefined ? { accountPassword } : {}),
      loyaltyNumber,
      loyaltyCardName,
      preferredBranch,
      autoPrepopulate: autoPrepopulate !== undefined ? Boolean(autoPrepopulate) : true,
      keepSignedIn: keepSignedIn !== undefined ? Boolean(keepSignedIn) : true,
    });

    return res.json({
      success: true,
      account: updated,
      allAccounts: getAllPersistedGroceryAccounts(),
    });
  });

  // API Route: Sync Resolved SKU Shopping List to Connected Supermarket Account
  app.post('/api/grocery-accounts/sync-list', (req: Request, res: Response) => {
    const { retailerId, items, syncTarget } = req.body || {};
    if (!retailerId || !Array.isArray(items)) {
      return res.status(400).json({ error: 'Missing retailerId or items array' });
    }

    const updated = syncSkusToPersistedAccount(
      retailerId,
      items,
      syncTarget === 'instore_list' ? 'instore_list' : 'online_trolley'
    );

    return res.json({
      success: true,
      account: updated,
    });
  });

  // API Route: Samsung Food (Whisk) Multi-Retailer Capabilities & Partner Status
  app.get('/api/samsung-food/retailers', (_req: Request, res: Response) => {
    const apiKey = Boolean(
      (process.env.SAMSUNG_FOOD_API_KEY || process.env.WHISK_API_TOKEN || '').trim()
    );
    return res.json({
      success: true,
      apiConfigured: apiKey,
      retailers: SAMSUNG_FOOD_UK_RETAILERS,
    });
  });

  // API Route: Create Samsung Food (Whisk) 1-Click Multi-Retailer Basket Batch
  app.post('/api/samsung-food/create-basket', async (req: Request, res: Response) => {
    try {
      const { retailerId, items, accountEmail } = req.body || {};
      if (!Array.isArray(items)) {
        return res.status(400).json({ error: 'Missing items array' });
      }
      const origin =
        req.headers.origin ||
        req.headers.referer?.replace(/\/$/, '') ||
        `http://localhost:${PORT}`;

      const batch = await createSamsungFoodBasketHandoff(
        retailerId || 'sainsburys',
        items,
        accountEmail,
        origin
      );
      return res.json({
        success: true,
        batch,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // API Route: Render Samsung Food (Whisk) Checkout Handoff & schema.org/Recipe Page
  app.get('/api/samsung-food/checkout/:batchId', (req: Request, res: Response) => {
    const batch = getSamsungFoodBatch(String(req.params.batchId || 'weekly-family-meal-plan'));
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(renderSamsungFoodCheckoutPageHtml(batch));
  });

  // Public Recipe Route for Samsung Food / Whisk URL Validator ("Enter a recipe URL from your site below and click Validate")
  app.get('/recipes/:slug', (req: Request, res: Response) => {
    const batch = getSamsungFoodBatch(String(req.params.slug || 'weekly-family-meal-plan'));
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(renderSamsungFoodCheckoutPageHtml(batch));
  });

  // API Route: Recent Webhook Logs (for inspection & testing)
  app.get('/api/webhook-logs', (_req: Request, res: Response) => {
    return res.json({
      logs: getWebhookLogs(),
      endpoint: '/api/stripe-webhook',
      eventHandled: 'checkout.session.completed',
      signatureHeader: 'stripe-signature',
      secretConfigured: Boolean(process.env.STRIPE_WEBHOOK_SECRET),
    });
  });

  // API Route: Simulate Webhook for development testing
  app.post('/api/test-simulate-webhook', async (req: Request, res: Response) => {
    try {
      const { customerEmail, userId, familyName, stripeCustomerId } = req.body || {};
      const fakeSessionId = `cs_test_${Date.now()}`;
      const fakeCustId = stripeCustomerId || `cus_test_${Date.now()}`;
      const targetUser = userId || 'usr_bowley_sarah';
      const targetEmail = customerEmail || 'bowleyn3@gmail.com';

      const record = await updateUserSubscription({
        userId: targetUser,
        customerEmail: targetEmail,
        familyName: familyName || 'The Bowley Family',
        isProMember: true,
        stripeCustomerId: fakeCustId,
        subscriptionId: `sub_test_${Date.now()}`,
        tier: 'all_access_annual',
        planName: 'Family All-Access Annual (£69.99/yr)',
        status: 'active',
        source: 'stripe_webhook',
        rawSessionId: fakeSessionId,
      });

      logWebhookEvent('checkout.session.completed', `evt_sim_${Date.now()}`, 'processed', {
        userId: targetUser,
        customerEmail: targetEmail,
        stripeCustomerId: fakeCustId,
        isProMember: true,
        simulated: true,
      });

      return res.json({
        success: true,
        message: `Simulated checkout.session.completed for ${targetUser} (${targetEmail}). Database updated.`,
        record,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // Mount Vite or Static Frontend
  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Family Ops server running on http://0.0.0.0:${PORT}`);
    console.log(`📡 Stripe Webhook listener active on http://0.0.0.0:${PORT}/api/stripe-webhook`);
  });
}

startServer().catch((err) => {
  console.error('Fatal error starting server:', err);
  process.exit(1);
});
