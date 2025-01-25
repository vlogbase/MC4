import { type Express, Request, Response, NextFunction } from "express";
import session from "express-session";
import createMemoryStore from "memorystore";
import passport from "passport";
import { IVerifyOptions, Strategy as LocalStrategy } from "passport-local";
import { scrypt, randomBytes, timingSafeEqual } from "crypto";
import { promisify } from "util";
import { users } from "@db/schema";
import { db } from "@db";
import { eq } from "drizzle-orm";

const scryptAsync = promisify(scrypt);

// OAuth Configuration
const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID || "affiliate-link-manager-client";
const OAUTH_CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET || randomBytes(32).toString('hex');
const OAUTH_SCOPES = ["rewrite"];

// Store OAuth tokens
const tokenStore = new Map<string, {
  accessToken: string,
  userId: number,
  expiresAt: number
}>();

const crypto = {
  hash: async (password: string) => {
    const salt = randomBytes(16).toString("hex");
    const buf = (await scryptAsync(password, salt, 64)) as Buffer;
    return `${buf.toString("hex")}.${salt}`;
  },
  compare: async (suppliedPassword: string, storedPassword: string) => {
    const [hashedPassword, salt] = storedPassword.split(".");
    const hashedPasswordBuf = Buffer.from(hashedPassword, "hex");
    const suppliedPasswordBuf = (await scryptAsync(
      suppliedPassword,
      salt,
      64
    )) as Buffer;
    return timingSafeEqual(hashedPasswordBuf, suppliedPasswordBuf);
  },
};

declare global {
  namespace Express {
    interface User extends SelectUser {}
    interface Request {
      oauthToken?: { userId: number };
    }
  }
}

export function verifyOAuthToken(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return next();
  }

  const token = authHeader.slice(7);
  const tokenData = tokenStore.get(token);

  if (!tokenData || tokenData.expiresAt < Date.now()) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  req.oauthToken = { userId: tokenData.userId };
  next();
}

export function authenticateRequest(req: Request, res: Response, next: NextFunction) {
  if (req.isAuthenticated() || req.oauthToken) {
    return next();
  }
  res.status(401).json({ error: "Authentication required" });
}

export function setupAuth(app: Express) {
  const MemoryStore = createMemoryStore(session);
  const sessionSettings: session.SessionOptions = {
    secret: process.env.REPL_ID || "porygon-supremacy",
    resave: false,
    saveUninitialized: false,
    cookie: {},
    store: new MemoryStore({
      checkPeriod: 86400000,
    }),
  };

  if (app.get("env") === "production") {
    app.set("trust proxy", 1);
    sessionSettings.cookie = {
      secure: true,
    };
  }

  app.use(session(sessionSettings));
  app.use(passport.initialize());
  app.use(passport.session());
  app.use(verifyOAuthToken);

  // OAuth endpoints
  app.post("/api/auth", async (req, res) => {
    const { client_id, client_secret } = req.body;

    if (client_id !== OAUTH_CLIENT_ID || client_secret !== OAUTH_CLIENT_SECRET) {
      return res.status(401).json({ error: "Invalid client credentials" });
    }

    // For OAuth flow, create a token without requiring user login
    // This is a simplified version - in production you'd want to associate this with a specific bot/service account
    const accessToken = randomBytes(32).toString('hex');
    tokenStore.set(accessToken, {
      accessToken,
      userId: 1, // Use a system/bot account ID
      expiresAt: Date.now() + (60 * 60 * 1000) // 1 hour expiry
    });

    res.json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 3600,
      scope: OAUTH_SCOPES.join(" ")
    });
  });

  app.post("/api/token", async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Basic ')) {
      return res.status(401).json({ error: "Missing authorization header" });
    }

    const [clientId, clientSecret] = Buffer.from(authHeader.slice(6), 'base64')
      .toString()
      .split(':');

    if (clientId !== OAUTH_CLIENT_ID || clientSecret !== OAUTH_CLIENT_SECRET) {
      return res.status(401).json({ error: "Invalid client credentials" });
    }

    const { grant_type, refresh_token } = req.body;
    if (grant_type !== "refresh_token" || !refresh_token) {
      return res.status(400).json({ error: "Invalid grant type or missing refresh token" });
    }

    // Validate refresh token and issue new access token
    // For now, we'll just issue a new token
    const accessToken = randomBytes(32).toString('hex');
    res.json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 3600,
      scope: OAUTH_SCOPES.join(" ")
    });
  });

  // Export OAuth credentials for frontend use
  app.get("/api/oauth-credentials", (req, res) => {
    res.json({
      client_id: OAUTH_CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
      authorization_url: `${req.protocol}://${req.get('host')}/api/auth`,
      token_url: `${req.protocol}://${req.get('host')}/api/token`,
      scopes: OAUTH_SCOPES,
      token_exchange_method: "basic_auth"
    });
  });

  passport.use(
    new LocalStrategy(async (username, password, done) => {
      try {
        const [user] = await db
          .select()
          .from(users)
          .where(eq(users.username, username))
          .limit(1);

        if (!user) {
          return done(null, false, { message: "Incorrect username." });
        }
        const isMatch = await crypto.compare(password, user.password);
        if (!isMatch) {
          return done(null, false, { message: "Incorrect password." });
        }
        return done(null, user);
      } catch (err) {
        return done(err);
      }
    })
  );

  passport.serializeUser((user, done) => {
    done(null, user.id);
  });

  passport.deserializeUser(async (id: number, done) => {
    try {
      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.id, id))
        .limit(1);
      done(null, user);
    } catch (err) {
      done(err);
    }
  });


  app.post("/api/register", async (req, res, next) => {
    try {
      const result = insertUserSchema.safeParse(req.body);
      if (!result.success) {
        return res
          .status(400)
          .send("Invalid input: " + result.error.issues.map(i => i.message).join(", "));
      }

      const { username, password } = result.data;

      const [existingUser] = await db
        .select()
        .from(users)
        .where(eq(users.username, username))
        .limit(1);

      if (existingUser) {
        return res.status(400).send("Username already exists");
      }

      const hashedPassword = await crypto.hash(password);

      const [newUser] = await db
        .insert(users)
        .values({
          username,
          password: hashedPassword,
        })
        .returning();

      req.login(newUser, (err) => {
        if (err) {
          return next(err);
        }
        return res.json({
          message: "Registration successful",
          user: newUser,
        });
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/login", (req, res, next) => {
    const result = insertUserSchema.safeParse(req.body);
    if (!result.success) {
      return res
        .status(400)
        .send("Invalid input: " + result.error.issues.map(i => i.message).join(", "));
    }

    passport.authenticate("local", (err: any, user: Express.User, info: IVerifyOptions) => {
      if (err) {
        return next(err);
      }

      if (!user) {
        return res.status(400).send(info.message ?? "Login failed");
      }

      req.logIn(user, (err) => {
        if (err) {
          return next(err);
        }

        return res.json({
          message: "Login successful",
          user: user,
        });
      });
    })(req, res, next);
  });

  app.post("/api/logout", (req, res) => {
    req.logout((err) => {
      if (err) {
        return res.status(500).send("Logout failed");
      }

      res.json({ message: "Logout successful" });
    });
  });

  app.get("/api/user", authenticateRequest, (req, res) => {
    // Use oauthToken or req.user depending on authentication method
    res.json(req.oauthToken ? { id: req.oauthToken.userId} : req.user);
  });
}

export function ensureAuthenticated(req: Request, res: Response, next: NextFunction) {
  if (req.isAuthenticated()) return next();
  return res.status(401).send("You must log in first.");
}