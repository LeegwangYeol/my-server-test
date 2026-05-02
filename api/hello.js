module.exports = (req, res) => {
  res.setHeader("content-type", "application/json");
  res.status(200).json({
    ok: true,
    message: "hello from vercel",
    ts: new Date().toISOString(),
    url: req.url,
    method: req.method,
  });
};
