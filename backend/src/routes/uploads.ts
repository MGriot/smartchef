// ════════════════════════════════════════════════════════════════════════
// SmartChef — Routes: Upload immagini
//
// Accetta un file immagine via multipart/form-data, lo ridimensiona e
// ricomprime in WebP (mantiene qualità visiva riducendo il peso su disco),
// e lo salva su filesystem locale. Restituisce un URL relativo
// (/uploads/<file>.webp) che si comporta esattamente come gli URL esterni
// già accettati dai campi immagine esistenti (cover_image_url, image_urls[],
// recipe_steps.image_url) — nessuna modifica di schema necessaria.
// ════════════════════════════════════════════════════════════════════════

import { Router, Request, Response } from "express";
import multer from "multer";
import sharp from "sharp";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { UPLOAD_DIR } from "../services/uploadDir";

export const uploadsRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      cb(new Error("Il file deve essere un'immagine"));
      return;
    }
    cb(null, true);
  },
});

uploadsRouter.post("/", upload.single("file"), async (req: Request, res: Response) => {
  if (!req.file) {
    return res.status(400).json({ error: "Nessun file caricato (campo 'file' mancante)" });
  }

  const filename = `${uuidv4()}.webp`;

  try {
    await sharp(req.file.buffer)
      .rotate()
      .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82 })
      .toFile(path.join(UPLOAD_DIR, filename));
  } catch (err) {
    console.error("Image upload processing failed:", err);
    return res.status(400).json({ error: "Impossibile elaborare l'immagine" });
  }

  res.status(201).json({ data: { url: `/uploads/${filename}` } });
});
