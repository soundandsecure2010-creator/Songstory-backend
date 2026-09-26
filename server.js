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

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "songstory-backend",
    stripe: Boolean(process.env.STRIPE_SECRET_KEY),
    music: Boolean(process.env.ELEVENLABS_API_KEY),
  });
});

app.post("/api/checkout", async (req, res) => {
  try {
    const { package: pkg, email, orderId } = req.body || {};

    if (!prices[pkg]) {
      return res.status(400).json({ error: "Invalid package" });
    }

    if (!process.env.STRIPE_SECRET_KEY) {
      return res.status(503).json({ error: "Payments not connected" });
    }

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

    const site =
      process.env.PUBLIC_SITE_URL ||
      "https://songstory-studio.higgsfield.app";

    const session = await stripe.checkout.sessions.create({
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
        orderId: String(orderId || ""),
      },
      success_url:
        site +
        "/?paid=1&session_id={CHECKOUT_SESSION_ID}",
      cancel_url: site + "/?payment=cancelled",
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not create checkout" });
  }
});

app.post("/api/music", async (req, res) => {
  try {
    if (
      !process.env.INTERNAL_API_KEY ||
      req.get("x-internal-key") !== process.env.INTERNAL_API_KEY
    ) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!process.env.ELEVENLABS_API_KEY) {
      return res.status(503).json({ error: "Music not connected" });
    }

    const { prompt } = req.body || {};

    if (typeof prompt !== "string" || prompt.length < 20) {
      return res.status(400).json({ error: "Invalid prompt" });
    }

    const response = await fetch(
      "https://api.elevenlabs.io/v1/music",
      {
        method: "POST",
        headers: {
          "xi-api-key": process.env.ELEVENLABS_API_KEY,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          prompt,
          music_length_ms: 180000,
        }),
      }
    );

    if (!response.ok) {
      return res.status(502).json({
        error: "Music provider failed",
        status: response.status,
      });
    }

    res.set("content-type", "audio/mpeg");
    res.send(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Music generation failed" });
  }
});

app.listen(port, () => {
  console.log(`SongStory backend listening on ${port}`);
});
