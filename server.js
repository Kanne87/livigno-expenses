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

// Expenses = real costs paid by someone for the group
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

// Transfers = money already sent between people (PayPal pool, bank transfers)
db.exec(`
  CREATE TABLE IF NOT EXISTS transfers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    from_person TEXT NOT NULL,
    to_person TEXT NOT NULL,
    amount REAL NOT NULL,
    note TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Seed if both tables empty
const expCount = db.prepare("SELECT COUNT(*) as c FROM expenses").get();
const txCount = db.prepare("SELECT COUNT(*) as c FROM transfers").get();

if (expCount.c === 0 && txCount.c === 0) {
  const insExp = db.prepare("INSERT INTO expenses (date, person, what, amount, for_who) VALUES (?, ?, ?, ?, ?)");
  const insTx = db.prepare("INSERT INTO transfers (date, from_person, to_person, amount, note) VALUES (?, ?, ?, ?, ?)");
  
  const tx = db.transaction(() => {
    // Real expenses
    insExp.run("15.02.", "Kai", "Flüge SkyAlps (4x)", 1576.99, "Alle");
    insExp.run("15.02.", "Kai", "Unterkunft Booking.com", 1240.00, "Alle");
    insExp.run("vor Reise", "Flo", "Mietwagen Ford Kuga", 158.11, "Alle");
    
    // Already completed transfers (PayPal Pool + bank transfer)
    insTx.run("12.02.", "Patrick L.", "Kai", 1018.61, "PayPal Pool");
    insTx.run("12.02.", "Patrick Lu.", "Kai", 1018.61, "PayPal Pool");
    insTx.run("12.02.", "Flo", "Kai", 1018.61, "PayPal Pool");
  });
  tx();
  console.log("✓ Preset expenses & transfers seeded");
}

// --- Middleware ---
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// --- Crew ---
const CREW = ["Kai", "Patrick L.", "Patrick Lu.", "Flo"];

// --- Settlement Logic ---
function calculateSettlement() {
  const expenses = db.prepare("SELECT * FROM expenses ORDER BY id ASC").all();
  const transfers = db.prepare("SELECT * FROM transfers ORDER BY id ASC").all();
  
  const totalExpenses = expenses.reduce((s, e) => s + e.amount, 0);
  const perPerson = totalExpenses / 4;
  
  // What each person paid for the group
  const paid = {};
  CREW.forEach(p => paid[p] = 0);
  expenses.forEach(e => {
    if (paid[e.person] !== undefined) paid[e.person] += e.amount;
  });
  
  // What each person owes (positive = overpaid, negative = underpaid)
  const rawBalances = {};
  CREW.forEach(p => rawBalances[p] = paid[p] - perPerson);
  
  // Apply completed transfers to balances
  // If A transferred money to B, it's like A paid more and B paid less
  const netBalances = { ...rawBalances };
  transfers.forEach(t => {
    if (netBalances[t.from_person] !== undefined) netBalances[t.from_person] += t.amount;
    if (netBalances[t.to_person] !== undefined) netBalances[t.to_person] -= t.amount;
  });
  
  // Calculate remaining transfers needed
  const debtors = CREW.filter(p => netBalances[p] < -0.01)
    .map(p => ({ name: p, amount: -netBalances[p] }))
    .sort((a, b) => b.amount - a.amount);
  const creditors = CREW.filter(p => netBalances[p] > 0.01)
    .map(p => ({ name: p, amount: netBalances[p] }))
    .sort((a, b) => b.amount - a.amount);
  
  const remainingTransfers = [];
  let di = 0, ci = 0;
  const d = debtors.map(x => ({ ...x }));
  const c = creditors.map(x => ({ ...x }));
  
  while (di < d.length && ci < c.length) {
    const transfer = Math.min(d[di].amount, c[ci].amount);
    if (transfer > 0.01) {
      remainingTransfers.push({ 
        from: d[di].name, 
        to: c[ci].name, 
        amount: Math.round(transfer * 100) / 100 
      });
    }
    d[di].amount -= transfer;
    c[ci].amount -= transfer;
    if (d[di].amount < 0.01) di++;
    if (c[ci].amount < 0.01) ci++;
  }
  
  // Total already transferred
  const totalTransferred = {};
  CREW.forEach(p => totalTransferred[p] = 0);
  transfers.forEach(t => {
    if (totalTransferred[t.from_person] !== undefined) totalTransferred[t.from_person] += t.amount;
  });
  
  return { 
    expenses, transfers, totalExpenses, perPerson, 
    paid, rawBalances, netBalances, 
    remainingTransfers, totalTransferred 
  };
}

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

// GET all transfers
app.get("/api/transfers", (req, res) => {
  const transfers = db.prepare("SELECT * FROM transfers ORDER BY id ASC").all();
  res.json(transfers);
});

// POST new transfer
app.post("/api/transfers", (req, res) => {
  const { from_person, to_person, amount, note } = req.body;
  if (!from_person || !to_person || !amount) {
    return res.status(400).json({ error: "from_person, to_person, and amount are required" });
  }
  const date = new Date().toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });
  const result = db.prepare(
    "INSERT INTO transfers (date, from_person, to_person, amount, note) VALUES (?, ?, ?, ?, ?)"
  ).run(date, from_person, to_person, parseFloat(amount), note || "");
  const transfer = db.prepare("SELECT * FROM transfers WHERE id = ?").get(result.lastInsertRowid);
  res.status(201).json(transfer);
});

// DELETE transfer
app.delete("/api/transfers/:id", (req, res) => {
  const result = db.prepare("DELETE FROM transfers WHERE id = ?").run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: "Not found" });
  res.json({ success: true });
});

// GET full settlement summary
app.get("/api/summary", (req, res) => {
  res.json(calculateSettlement());
});

// Webhook endpoint for n8n
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
  res.json({ success: true, message: `✓ ${was}: ${betrag}€ von ${person}`, expense });
});

// --- Start ---
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🏂 Livigno Expense Tracker running on port ${PORT}`);
});
