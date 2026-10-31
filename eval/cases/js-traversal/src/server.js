const express = require("express");
const path = require("path");
const app = express();
const ROOT = path.join(__dirname, "public");

// Download any file the client names.
app.get("/download", (req, res) => {
  const name = req.query.file;
  res.sendFile(path.join(ROOT, name));
});

// Safe variant: resolved path must stay inside ROOT.
app.get("/download-safe", (req, res) => {
  const p = path.resolve(ROOT, String(req.query.file || ""));
  if (!p.startsWith(ROOT + path.sep)) return res.status(400).end();
  res.sendFile(p);
});

app.listen(3000);
