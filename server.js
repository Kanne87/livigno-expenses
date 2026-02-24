const express = require("express");
const Database = require("better-sqlite3");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// --- Database Setup ---
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data", "expenses.db");
const fs = require("fs");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    person TEXT NOT NULL,
    what TEXT NOT NULL,
    amount REAL NOT NULL,
    for_who TEXT NOT NULL DEFAULT 'Alle',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

// Seed preset expenses if table is empty
const count = db.prepare("SELECT COUNT(*) as c FROM expenses").get();
if (count.c === 0) {
  const insert = db.prepare("INSERT INTO expenses (date, person, what, amount, for_who) VALUES (?, ?, ?, ?, ?)");
  const presets = [
    ["vor Reise", "Kai", "Flüge SkyAlps (4x)", 1576.99, "Alle"],
    ["vor Reise", "Flo", "Mietwagen Ford Kuga", 158.11, "Alle"],
  ];
  const tx = db.transaction(() => {
    for (const p of presets) insert.run(...p);
  });
  tx();
  console.log("✓ Preset expenses seeded");
}

// --- Middleware ---
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// --- API Routes ---

// GET all expenses
app.get("/api/expenses", (req, res) => {
  const expenses = db.prepare("SELECT * FROM expenses ORDER BY id ASC").all();
  res.json(expenses);
});

// POST new expense
app.post("/api/expenses", (req, res) => {
  const { person, what, amount, for_who } = req.body;
  if (!person || !what || !amount) {
    return res.status(400).json({ error: "person, what, and amount are required" });
  }
  const date = new Date().toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });
  const result = db.prepare(
    "INSERT INTO expenses (date, person, what, amount, for_who) VALUES (?, ?, ?, ?, ?)"
  ).run(date, person, what, parseFloat(amount), for_who || "Alle");
  
  const expense = db.prepare("SELECT * FROM expenses WHERE id = ?").get(result.lastInsertRowid);
  res.status(201).json(expense);
});

// DELETE expense
app.delete("/api/expenses/:id", (req, res) => {
  const result = db.prepare("DELETE FROM expenses WHERE id = ?").run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: "Not found" });
  res.json({ success: true });
});

// PUT update expense
app.put("/api/expenses/:id", (req, res) => {
  const { person, what, amount, for_who } = req.body;
  const result = db.prepare(
    "UPDATE expenses SET person = ?, what = ?, amount = ?, for_who = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(person, what, parseFloat(amount), for_who || "Alle", req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: "Not found" });
  const expense = db.prepare("SELECT * FROM expenses WHERE id = ?").get(req.params.id);
  res.json(expense);
});

// GET summary/settlement
app.get("/api/summary", (req, res) => {
  const expenses = db.prepare("SELECT * FROM expenses").all();
  const crew = ["Kai", "Patrick L.", "Patrick Lu.", "Flo"];
  
  const totalAll = expenses.reduce((s, e) => s + e.amount, 0);
  const perPerson = totalAll / 4;
  
  const paid = {};
  crew.forEach(p => paid[p] = 0);
  expenses.forEach(e => {
    if (paid[e.person] !== undefined) paid[e.person] += e.amount;
  });
  
  const balances = {};
  crew.forEach(p => balances[p] = paid[p] - perPerson);
  
  // Calculate minimum transfers
  const debtors = crew.filter(p => balances[p] < -0.01).map(p => ({ name: p, amount: -balances[p] })).sort((a, b) => b.amount - a.amount);
  const creditors = crew.filter(p => balances[p] > 0.01).map(p => ({ name: p, amount: balances[p] })).sort((a, b) => b.amount - a.amount);
  
  const transfers = [];
  let di = 0, ci = 0;
  const d = debtors.map(x => ({ ...x }));
  const c = creditors.map(x => ({ ...x }));
  
  while (di < d.length && ci < c.length) {
    const transfer = Math.min(d[di].amount, c[ci].amount);
    if (transfer > 0.01) {
      transfers.push({ from: d[di].name, to: c[ci].name, amount: Math.round(transfer * 100) / 100 });
    }
    d[di].amount -= transfer;
    c[ci].amount -= transfer;
    if (d[di].amount < 0.01) di++;
    if (c[ci].amount < 0.01) ci++;
  }
  
  res.json({ total: totalAll, perPerson, paid, balances, transfers });
});

// Webhook endpoint for n8n integration
app.get("/api/webhook/add", (req, res) => {
  const { person, betrag, was, fuer } = req.query;
  if (!person || !betrag || !was) {
    return res.status(400).json({ error: "Required: ?person=Kai&betrag=25.50&was=Supermarkt" });
  }
  const date = new Date().toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });
  const result = db.prepare(
    "INSERT INTO expenses (date, person, what, amount, for_who) VALUES (?, ?, ?, ?, ?)"
  ).run(date, person, was, parseFloat(betrag), fuer || "Alle");
  
  const expense = db.prepare("SELECT * FROM expenses WHERE id = ?").get(result.lastInsertRowid);
  res.json({ success: true, message: `✓ ${was}: ${betrag}€ von ${person} hinzugefügt`, expense });
});

// --- Start ---
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🏂 Livigno Expense Tracker running on port ${PORT}`);
});
