import argon2 from "argon2";
import * as OTPAuth from "otpauth";
import QRCode from "qrcode";
import { db, migrate } from "./db.js";
import { seal } from "./security.js";
import { validateConfig } from "./config.js";
validateConfig();
await migrate();
if ((await db.query("SELECT 1 FROM owner")).rowCount)
  throw new Error(
    "Owner already exists; setup does not overwrite credentials.",
  );
const password = process.env.OWNER_PASSWORD;
if (!password || password.length < 14)
  throw new Error(
    "Provide OWNER_PASSWORD (14+ characters) through environment, never a command argument.",
  );
const totp = new OTPAuth.TOTP({
  issuer: "AI Workspace",
  label: "Owner",
  secret: new OTPAuth.Secret({ size: 20 }),
});
await db.query(
  "INSERT INTO owner(id,password_hash,totp_secret) VALUES(1,$1,$2)",
  [
    await argon2.hash(password, { type: argon2.argon2id }),
    seal(totp.secret.base32),
  ],
);
console.log(
  await QRCode.toString(totp.toString(), { type: "terminal", small: true }),
);
console.log(
  "Add this TOTP key to your authenticator and store it safely:",
  totp.secret.base32,
);
await db.end();
