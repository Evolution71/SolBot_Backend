import { Router } from "express";
import { supabase } from "../db/supabase";

export const supportRouter = Router();

supportRouter.post("/", async (req, res) => {
  const { email, subject, message } = req.body ?? {};

  if (!subject || typeof subject !== "string" || subject.trim().length < 2) {
    return res.status(400).json({ error: "Please provide a subject." });
  }
  if (!message || typeof message !== "string" || message.trim().length < 5) {
    return res.status(400).json({ error: "Please provide a message." });
  }

  const { error } = await supabase.from("support_tickets").insert({
    email: typeof email === "string" ? email.trim() : null,
    subject: subject.trim(),
    message: message.trim(),
  });

  if (error) {
    return res.status(500).json({ error: "Something went wrong — please try again." });
  }

  res.status(200).json({ ok: true });
});
