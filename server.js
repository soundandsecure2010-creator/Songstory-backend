import express from "express";
import Stripe from "stripe";

const app = express();
const port = process.env.PORT || 10000;

const prices = {
  standard: 3900,
  premium: 6900,
  rush: 9900,
};

app.use(express.json({ limit: "1mb" }));

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "SongStory Backend",
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "songstory-backend",
    stripe: Boolean(process.env.STRIPE_SECRET_KEY),
    music: Boolean(process.env.ELEVENLABS_API_KEY),
  });
});

/*
 * CREATE STRIPE CHECKOUT
 */
app.post("/api/checkout", async (req, res) => {
  try {
    const {
      package: pkg,
      email,
      orderId,
      token,
    } = req.body || {};

    if (!prices[pkg]) {
      return res.status(400).json({
        error: "Invalid package",
      });
    }

    if (!orderId || !token) {
      return res.status(400).json({
        error: "Missing order information",
      });
    }

    if (!process.env.STRIPE_SECRET_KEY) {
      return res.status(503).json({
        error: "Payments not connected",
      });
    }

    const stripe = new Stripe(
      process.env.STRIPE_SECRET_KEY
    );

    const site =
      process.env.PUBLIC_SITE_URL ||
      "https://songstory-studio.higgsfield.app";

    const session =
      await stripe.checkout.sessions.create({
        mode: "payment",

        customer_email: email || undefined,

        line_items: [
          {
            price_data: {
              currency: "usd",

              unit_amount: prices[pkg],

              product_data: {
                name:
                  "SongStory " +
                  pkg.charAt(0).toUpperCase() +
                  pkg.slice(1),
              },
            },

            quantity: 1,
          },
        ],

        metadata: {
          orderId: String(orderId),
          token: String(token),
          package: String(pkg),
        },

        success_url:
          site +
          "/order/" +
          encodeURIComponent(token) +
          "?session_id={CHECKOUT_SESSION_ID}",

        cancel_url:
          site +
          "/order/" +
          encodeURIComponent(token) +
          "?payment=cancelled",
      });

    res.json({
      url: session.url,
    });
  } catch (error) {
    console.error("Stripe checkout error:", error);

    res.status(500).json({
      error: "Could not create checkout",
    });
  }
});

/*
 * VERIFY STRIPE PAYMENT
 *
 * The browser never decides whether an order
 * was paid. We ask Stripe directly.
 */
app.post(
  "/api/checkout/verify",
  async (req, res) => {
    try {
      const { sessionId } = req.body || {};

      if (
        typeof sessionId !== "string" ||
        !sessionId.startsWith("cs_")
      ) {
        return res.status(400).json({
          error: "Invalid checkout session",
        });
      }

      if (!process.env.STRIPE_SECRET_KEY) {
        return res.status(503).json({
          error: "Payments not connected",
        });
      }

      const stripe = new Stripe(
        process.env.STRIPE_SECRET_KEY
      );

      const session =
        await stripe.checkout.sessions.retrieve(
          sessionId
        );

      const paid =
        session.payment_status === "paid";

      res.json({
        paid,
        orderId:
          session.metadata?.orderId || null,
        token:
          session.metadata?.token || null,
        package:
          session.metadata?.package || null,
      });
    } catch (error) {
      console.error(
        "Stripe verification error:",
        error
      );

      res.status(500).json({
        error: "Could not verify payment",
      });
    }
  }
);

/*
 * GENERATE MUSIC
 *
 * Protected so customers cannot directly burn
 * through the ElevenLabs account.
 */
app.post("/api/music", async (req, res) => {
  try {
    if (
      !process.env.INTERNAL_API_KEY ||
      req.get("x-internal-key") !==
        process.env.INTERNAL_API_KEY
    ) {
      return res.status(401).json({
        error: "Unauthorized",
      });
    }

    if (!process.env.ELEVENLABS_API_KEY) {
      return res.status(503).json({
        error: "Music not connected",
      });
    }

    const { prompt } = req.body || {};

    if (
      typeof prompt !== "string" ||
      prompt.length < 20
    ) {
      return res.status(400).json({
        error: "Invalid prompt",
      });
    }

    const response = await fetch(
      "https://api.elevenlabs.io/v1/music",
      {
        method: "POST",

        headers: {
          "xi-api-key":
            process.env.ELEVENLABS_API_KEY,

          "content-type":
            "application/json",
        },

        body: JSON.stringify({
          prompt,
          music_length_ms: 180000,
        }),
      }
    );

    if (!response.ok) {
      const details =
        await response.text().catch(() => "");

      console.error(
        "ElevenLabs error:",
        response.status,
        details.slice(0, 500)
      );

      return res.status(502).json({
        error: "Music provider failed",
        status: response.status,
      });
    }

    const audio =
      Buffer.from(
        await response.arrayBuffer()
      );

    res.set("content-type", "audio/mpeg");
    res.set(
      "cache-control",
      "private, no-store"
    );

    res.send(audio);
  } catch (error) {
    console.error(
      "Music generation error:",
      error
    );

    res.status(500).json({
      error: "Music generation failed",
    });
  }
});

app.listen(port, () => {
  console.log(
    `SongStory backend listening on ${port}`
  );
});
