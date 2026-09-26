import express from "express";
import Stripe from "stripe";

const app = express();
const port = process.env.PORT || 10000;

const SITE_URL =
  process.env.PUBLIC_SITE_URL ||
  "https://songami.higgsfield.app";

const prices = {
  standard: 3900,
  premium: 6900,
  rush: 9900,
};

const packageNames = {
  standard: "Songami — 1 personalized song",
  premium: "Songami — 2 personalized songs",
  rush: "Songami — 3 personalized songs",
};

app.use(express.json({ limit: "1mb" }));

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error("Payments not connected");
  }

  return new Stripe(
    process.env.STRIPE_SECRET_KEY
  );
}

function validEmail(value) {
  return (
    typeof value === "string" &&
    value.length <= 200 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
  );
}

function validToken(value) {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9_-]{20,100}$/.test(value)
  );
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/* =========================
   STATUS
========================= */

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "Songami Backend",
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "songami-backend",

    stripe: Boolean(
      process.env.STRIPE_SECRET_KEY
    ),

    music: Boolean(
      process.env.ELEVENLABS_API_KEY
    ),

    email: Boolean(
      process.env.RESEND_API_KEY
    ),
  });
});

/* =========================
   RESEND EMAIL
========================= */

async function sendEmail({
  to,
  subject,
  html,
}) {
  if (!process.env.RESEND_API_KEY) {
    throw new Error(
      "EMAIL_NOT_CONNECTED"
    );
  }

  if (!validEmail(to)) {
    throw new Error(
      "INVALID_EMAIL"
    );
  }

  const response = await fetch(
    "https://api.resend.com/emails",
    {
      method: "POST",

      headers: {
        Authorization:
          `Bearer ${process.env.RESEND_API_KEY}`,

        "Content-Type":
          "application/json",
      },

      body: JSON.stringify({
        from:
          process.env.EMAIL_FROM ||
          "Songami <onboarding@resend.dev>",

        to: [to],

        subject,

        html,
      }),
    }
  );

  if (!response.ok) {
    const details =
      await response
        .text()
        .catch(() => "");

    console.error(
      "Resend failure:",
      response.status,
      details.slice(0, 500)
    );

    const error =
      new Error("EMAIL_FAILED");

    error.providerStatus =
      response.status;

    throw error;
  }

  const result =
    await response.json();

  console.log(
    "Songami email sent:",
    result?.id || "accepted"
  );

  return result;
}

/* =========================
   STRIPE CHECKOUT
========================= */

app.post(
  "/api/checkout",
  async (req, res) => {
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

      if (
        !orderId ||
        !validToken(token)
      ) {
        return res.status(400).json({
          error:
            "Missing order information",
        });
      }

      if (
        email &&
        !validEmail(email)
      ) {
        return res.status(400).json({
          error:
            "Invalid email address",
        });
      }

      const stripe = getStripe();

      const session =
        await stripe.checkout.sessions.create({
          mode: "payment",

          customer_email:
            email || undefined,

          line_items: [
            {
              price_data: {
                currency: "usd",

                unit_amount:
                  prices[pkg],

                product_data: {
                  name:
                    packageNames[pkg],
                },
              },

              quantity: 1,
            },
          ],

          metadata: {
            orderId:
              String(orderId),

            token:
              String(token),

            package:
              String(pkg),
          },

          success_url:
            SITE_URL +
            "/order/" +
            encodeURIComponent(token) +
            "?session_id={CHECKOUT_SESSION_ID}",

          cancel_url:
            SITE_URL +
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
        error:
          "Could not create checkout",
      });
    }
  }
);

/* =========================
   VERIFY STRIPE PAYMENT
========================= */

app.post(
  "/api/checkout/verify",
  async (req, res) => {
    try {
      const {
        sessionId,
      } = req.body || {};

      if (
        typeof sessionId !==
          "string" ||
        !sessionId.startsWith(
          "cs_"
        )
      ) {
        return res
          .status(400)
          .json({
            error:
              "Invalid checkout session",
          });
      }

      const stripe =
        getStripe();

      const session =
        await stripe.checkout.sessions.retrieve(
          sessionId
        );

      res.json({
        paid:
          session.payment_status ===
          "paid",

        orderId:
          session.metadata
            ?.orderId || null,

        token:
          session.metadata
            ?.token || null,

        package:
          session.metadata
            ?.package || null,

        email:
          session.customer_details
            ?.email ||
          session.customer_email ||
          null,
      });
    } catch (error) {
      console.error(
        "Stripe verification error:",
        error
      );

      res.status(500).json({
        error:
          "Could not verify payment",
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
  if (
    !process.env
      .ELEVENLABS_API_KEY
  ) {
    throw new Error(
      "ELEVENLABS_NOT_CONNECTED"
    );
  }

  const response =
    await fetch(
      "https://api.elevenlabs.io/v1/music",
      {
        method: "POST",

        headers: {
          "xi-api-key":
            process.env
              .ELEVENLABS_API_KEY,

          "content-type":
            "application/json",
        },

        body: JSON.stringify({
          prompt,
          music_length_ms:
            musicLengthMs,
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
      new Error(
        "ELEVENLABS_FAILED"
      );

    error.providerStatus =
      response.status;

    throw error;
  }

  const audio =
    Buffer.from(
      await response.arrayBuffer()
    );

  const contentType =
    response.headers.get(
      "content-type"
    ) || "audio/mpeg";

  console.log(
    "Songami music generated:",
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

app.post(
  "/api/music",
  async (req, res) => {
    try {
      const {
        prompt,
        sessionId,
      } = req.body || {};

      if (
        typeof prompt !==
          "string" ||
        prompt.length < 20
      ) {
        return res
          .status(400)
          .json({
            error:
              "Invalid prompt",
          });
      }

      if (
        typeof sessionId !==
          "string" ||
        !sessionId.startsWith(
          "cs_"
        )
      ) {
        return res
          .status(401)
          .json({
            error:
              "Valid payment required",
          });
      }

      /*
       * Verify the Stripe payment
       * before using ElevenLabs
       * credits for customer orders.
       */

      const stripe =
        getStripe();

      const session =
        await stripe.checkout.sessions.retrieve(
          sessionId
        );

      if (
        session.payment_status !==
        "paid"
      ) {
        return res
          .status(402)
          .json({
            error:
              "Payment required",
          });
      }

      if (
        !session.metadata
          ?.orderId ||
        !session.metadata
          ?.token
      ) {
        return res
          .status(400)
          .json({
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
        return res
          .status(503)
          .json({
            error:
              "Music generation not connected",
          });
      }

      if (
        error?.message ===
        "ELEVENLABS_FAILED"
      ) {
        return res
          .status(502)
          .json({
            error:
              "Music provider failed",

            status:
              error.providerStatus ||
              502,
          });
      }

      res.status(500).json({
        error:
          "Music generation failed",
      });
    }
  }
);

/* =========================
   ORDER CONFIRMATION EMAIL
========================= */

app.post(
  "/api/email/order",
  async (req, res) => {
    try {
      const {
        email,
        recipient,
        token,
        sessionId,
      } = req.body || {};

      if (
        !validEmail(email) ||
        !validToken(token) ||
        typeof sessionId !==
          "string" ||
        !sessionId.startsWith(
          "cs_"
        )
      ) {
        return res
          .status(400)
          .json({
            error:
              "Invalid email request",
          });
      }

      /*
       * Require a real paid Stripe
       * session matching the private
       * order token.
       */

      const stripe =
        getStripe();

      const session =
        await stripe.checkout.sessions.retrieve(
          sessionId
        );

      if (
        session.payment_status !==
          "paid" ||
        session.metadata
          ?.token !== token
      ) {
        return res
          .status(403)
          .json({
            error:
              "Verified payment required",
          });
      }

      const orderUrl =
        SITE_URL +
        "/order/" +
        encodeURIComponent(token);

      const safeRecipient =
        escapeHtml(
          recipient || "your song"
        );

      await sendEmail({
        to: email,

        subject:
          "Your Songami order is confirmed",

        html: `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#171717">
            <h1>Songami</h1>

            <p>Your payment is confirmed.</p>

            <p>
              We're creating your personalized Songami for
              <strong>${safeRecipient}</strong>.
            </p>

            <p>
              Keep this private link. It is where you can
              check your order and download your finished song or songs.
            </p>

            <p style="margin:28px 0">
              <a
                href="${orderUrl}"
                style="background:#171717;color:#fff;padding:12px 18px;text-decoration:none;border-radius:8px"
              >
                Open your Songami order
              </a>
            </p>

            <p style="font-size:12px;color:#666">
              This link is private. Please don't share it publicly.
            </p>
          </div>
        `,
      });

      res.json({
        ok: true,
      });
    } catch (error) {
      console.error(
        "Order email error:",
        error
      );

      res.status(500).json({
        error:
          "Could not send order email",
      });
    }
  }
);

/* =========================
   FINISHED SONG EMAIL
========================= */

app.post(
  "/api/email/ready",
  async (req, res) => {
    try {
      const {
        email,
        recipient,
        token,
        sessionId,
      } = req.body || {};

      if (
        !validEmail(email) ||
        !validToken(token) ||
        typeof sessionId !==
          "string" ||
        !sessionId.startsWith(
          "cs_"
        )
      ) {
        return res
          .status(400)
          .json({
            error:
              "Invalid email request",
          });
      }

      const stripe =
        getStripe();

      const session =
        await stripe.checkout.sessions.retrieve(
          sessionId
        );

      if (
        session.payment_status !==
          "paid" ||
        session.metadata
          ?.token !== token
      ) {
        return res
          .status(403)
          .json({
            error:
              "Verified payment required",
          });
      }

      const orderUrl =
        SITE_URL +
        "/order/" +
        encodeURIComponent(token);

      const safeRecipient =
        escapeHtml(
          recipient || "your song"
        );

      await sendEmail({
        to: email,

        subject:
          "Your Songami is ready 🎵",

        html: `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#171717">
            <h1>Your Songami is ready.</h1>

            <p>
              Your personalized Songami for
              <strong>${safeRecipient}</strong>
              is finished.
            </p>

            <p>
              Use your private order page to download
              every finished MP3 included in your order.
            </p>

            <p style="margin:28px 0">
              <a
                href="${orderUrl}"
                style="background:#171717;color:#fff;padding:12px 18px;text-decoration:none;border-radius:8px"
              >
                Download your Songami
              </a>
            </p>

            <p style="font-size:12px;color:#666">
              This is your private delivery link.
            </p>
          </div>
        `,
      });

      res.json({
        ok: true,
      });
    } catch (error) {
      console.error(
        "Finished email error:",
        error
      );

      res.status(500).json({
        error:
          "Could not send finished-song email",
      });
    }
  }
);

/* =========================
   PRIVATE DEMO GENERATION
========================= */

app.post(
  "/api/demo/music",
  async (req, res) => {
    try {
      const secret =
        req.headers["x-demo-secret"];

      /*
       * This endpoint intentionally
       * bypasses Stripe only for
       * private Songami showcase
       * generation.
       *
       * The secret lives in Render,
       * never in the website.
       */

      if (
        !process.env.DEMO_SECRET ||
        secret !==
          process.env.DEMO_SECRET
      ) {
        return res
          .status(403)
          .json({
            error: "Forbidden",
          });
      }

      const {
        prompt,
      } = req.body || {};

      if (
        typeof prompt !== "string" ||
        prompt.length < 20 ||
        prompt.length > 5000
      ) {
        return res
          .status(400)
          .json({
            error:
              "Invalid prompt",
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
        "Demo generation error:",
        error
      );

      if (
        error?.message ===
        "ELEVENLABS_NOT_CONNECTED"
      ) {
        return res
          .status(503)
          .json({
            error:
              "Music generation not connected",
          });
      }

      if (
        error?.message ===
        "ELEVENLABS_FAILED"
      ) {
        return res
          .status(502)
          .json({
            error:
              "Music provider failed",

            status:
              error.providerStatus ||
              502,
          });
      }

      res.status(500).json({
        error:
          "Demo generation failed",
      });
    }
  }
);

/* =========================
   START SERVER
========================= */

app.listen(port, () => {
  console.log(
    `Songami backend listening on ${port}`
  );
});
