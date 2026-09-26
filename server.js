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

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error("Payments not connected");
  }

  return new Stripe(process.env.STRIPE_SECRET_KEY);
}

/* =========================
   STATUS
========================= */

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

/* =========================
   STRIPE CHECKOUT
========================= */

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

    const stripe = getStripe();

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
    console.error(
      "Stripe checkout error:",
      error
    );

    res.status(500).json({
      error: "Could not create checkout",
    });
  }
});

/* =========================
   VERIFY STRIPE PAYMENT
========================= */

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

      const stripe = getStripe();

      const session =
        await stripe.checkout.sessions.retrieve(
          sessionId
        );

      res.json({
        paid:
          session.payment_status === "paid",

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

/* =========================
   ELEVENLABS MUSIC
========================= */

async function requestMusic(
  prompt,
  musicLengthMs
) {
  if (!process.env.ELEVENLABS_API_KEY) {
    throw new Error(
      "ELEVENLABS_NOT_CONNECTED"
    );
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
        music_length_ms: musicLengthMs,
      }),
    }
  );

  if (!response.ok) {
    const details =
      await response
        .text()
        .catch(() => "");

    console.error(
      "ElevenLabs music failure:",
      response.status,
      details.slice(0, 500)
    );

    const error =
      new Error("ELEVENLABS_FAILED");

    error.providerStatus =
      response.status;

    throw error;
  }

  const audio = Buffer.from(
    await response.arrayBuffer()
  );

  const contentType =
    response.headers.get(
      "content-type"
    ) || "audio/mpeg";

  console.log(
    "SongStory music generated:",
    audio.length,
    "bytes",
    contentType
  );

  return {
    audio,
    contentType,
  };
}

/* =========================
   PAID SONG GENERATION
========================= */

app.post("/api/music", async (req, res) => {
  try {
    const {
      prompt,
      sessionId,
    } = req.body || {};

    if (
      typeof prompt !== "string" ||
      prompt.length < 20
    ) {
      return res.status(400).json({
        error: "Invalid prompt",
      });
    }

    if (
      typeof sessionId !== "string" ||
      !sessionId.startsWith("cs_")
    ) {
      return res.status(401).json({
        error: "Valid payment required",
      });
    }

    /*
     * Verify the Checkout Session
     * directly with Stripe before
     * spending ElevenLabs credits.
     */

    const stripe = getStripe();

    const session =
      await stripe.checkout.sessions.retrieve(
        sessionId
      );

    if (
      session.payment_status !== "paid"
    ) {
      return res.status(402).json({
        error: "Payment required",
      });
    }

    if (!session.metadata?.orderId) {
      return res.status(400).json({
        error:
          "Checkout is missing order information",
      });
    }

    const {
      audio,
      contentType,
    } = await requestMusic(
      prompt,
      180000
    );

    res.set(
      "content-type",
      contentType
    );

    res.set(
      "content-length",
      String(audio.length)
    );

    res.set(
      "cache-control",
      "private, no-store"
    );

    res.set(
      "x-content-type-options",
      "nosniff"
    );

    res.send(audio);
  } catch (error) {
    console.error(
      "Music generation error:",
      error
    );

    if (
      error?.message ===
      "ELEVENLABS_NOT_CONNECTED"
    ) {
      return res.status(503).json({
        error:
          "Music generation not connected",
      });
    }

    if (
      error?.message ===
      "ELEVENLABS_FAILED"
    ) {
      return res.status(502).json({
        error:
          "Music provider failed",

        status:
          error.providerStatus || 502,
      });
    }

    res.status(500).json({
      error:
        "Music generation failed",
    });
  }
});

/* =========================
   START SERVER
========================= */

app.listen(port, () => {
  console.log(
    `SongStory backend listening on ${port}`
  );
});
