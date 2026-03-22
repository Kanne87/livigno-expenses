const express = require("express");
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";

// --- Database Setup ---
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data", "expenses.db");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// --- Schema Migration ---
db.exec(`
  CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    person TEXT NOT NULL,
    what TEXT NOT NULL,
    amount REAL NOT NULL,
    for_who TEXT NOT NULL DEFAULT 'Alle',
    category TEXT DEFAULT 'other',
    merchant TEXT,
    details TEXT,
    receipt_data TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

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

db.exec(`
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id INTEGER,
    description TEXT,
    actor TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Safe column additions (idempotent)
const cols = db.prepare("PRAGMA table_info(expenses)").all().map(c => c.name);
if (!cols.includes("category")) db.exec("ALTER TABLE expenses ADD COLUMN category TEXT DEFAULT 'other'");
if (!cols.includes("merchant")) db.exec("ALTER TABLE expenses ADD COLUMN merchant TEXT");
if (!cols.includes("details")) db.exec("ALTER TABLE expenses ADD COLUMN details TEXT");
if (!cols.includes("receipt_data")) db.exec("ALTER TABLE expenses ADD COLUMN receipt_data TEXT");

// Seed if both tables empty
const expCount = db.prepare("SELECT COUNT(*) as c FROM expenses").get();
const txCount = db.prepare("SELECT COUNT(*) as c FROM transfers").get();

if (expCount.c === 0 && txCount.c === 0) {
  const insExp = db.prepare("INSERT INTO expenses (date, person, what, amount, for_who, category) VALUES (?, ?, ?, ?, ?, ?)");
  const insTx = db.prepare("INSERT INTO transfers (date, from_person, to_person, amount, note) VALUES (?, ?, ?, ?, ?)");
  const insLog = db.prepare("INSERT INTO audit_log (action, entity_type, entity_id, description, actor) VALUES (?, ?, ?, ?, ?)");
  
  const tx = db.transaction(() => {
    insExp.run("15.02.", "Kai", "Flüge SkyAlps (4x)", 1576.99, "Alle", "transport");
    insExp.run("15.02.", "Kai", "Unterkunft Booking.com", 1240.00, "Alle", "accommodation");
    insExp.run("vor Reise", "Flo", "Mietwagen Ford Kuga", 158.11, "Alle", "transport");
    insTx.run("12.02.", "Patrick L.", "Kai", 1018.61, "PayPal Pool");
    insTx.run("12.02.", "Patrick Lu.", "Kai", 1018.61, "PayPal Pool");
    insTx.run("12.02.", "Flo", "Kai", 1018.61, "PayPal Pool");
    insLog.run("init", "system", null, "Gruppenkasse initialisiert mit Seed-Daten", "system");
  });
  tx();
  console.log("✓ Seeded expenses, transfers & audit log");
}

// --- Middleware ---
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

// --- Crew ---
const FULL_CREW = ["Kai", "Patrick L.", "Patrick Lu.", "Flo"];
const ACTIVE_CREW = ["Kai", "Patrick L.", "Flo"];

function resolveForWho(forWho) {
  if (forWho === "Alle") return FULL_CREW;
  if (forWho === "Reise") return ACTIVE_CREW;
  // Comma-separated list: "Flo,Patrick L."
  if (forWho.includes(",")) return forWho.split(",").map(s => s.trim()).filter(s => FULL_CREW.includes(s));
  if (FULL_CREW.includes(forWho)) return [forWho];
  return ACTIVE_CREW;
}

// --- Settlement Logic ---
function calculateSettlement() {
  const expenses = db.prepare("SELECT id,date,person,what,amount,for_who,category,merchant,details,created_at,updated_at FROM expenses ORDER BY id ASC").all();
  const transfers = db.prepare("SELECT * FROM transfers ORDER BY id ASC").all();
  const totalExpenses = expenses.reduce((s, e) => s + e.amount, 0);
  
  const owes = {}; FULL_CREW.forEach(p => owes[p] = 0);
  expenses.forEach(e => {
    const group = resolveForWho(e.for_who);
    const share = e.amount / group.length;
    group.forEach(p => { owes[p] += share; });
  });
  
  const paid = {}; FULL_CREW.forEach(p => paid[p] = 0);
  expenses.forEach(e => { if (paid[e.person] !== undefined) paid[e.person] += e.amount; });
  
  const rawBalances = {}; FULL_CREW.forEach(p => rawBalances[p] = paid[p] - owes[p]);
  const netBalances = { ...rawBalances };
  transfers.forEach(t => {
    if (netBalances[t.from_person] !== undefined) netBalances[t.from_person] += t.amount;
    if (netBalances[t.to_person] !== undefined) netBalances[t.to_person] -= t.amount;
  });
  
  const debtors = FULL_CREW.filter(p => netBalances[p] < -0.01).map(p => ({ name: p, amount: -netBalances[p] })).sort((a,b) => b.amount-a.amount);
  const creditors = FULL_CREW.filter(p => netBalances[p] > 0.01).map(p => ({ name: p, amount: netBalances[p] })).sort((a,b) => b.amount-a.amount);
  
  const remainingTransfers = [];
  let di=0, ci=0;
  const d = debtors.map(x => ({...x})), c = creditors.map(x => ({...x}));
  while (di < d.length && ci < c.length) {
    const transfer = Math.min(d[di].amount, c[ci].amount);
    if (transfer > 0.01) remainingTransfers.push({ from: d[di].name, to: c[ci].name, amount: Math.round(transfer*100)/100 });
    d[di].amount -= transfer; c[ci].amount -= transfer;
    if (d[di].amount < 0.01) di++; if (c[ci].amount < 0.01) ci++;
  }
  
  return { expenses, transfers, totalExpenses, owes, paid, rawBalances, netBalances, remainingTransfers, fullCrew: FULL_CREW, activeCrew: ACTIVE_CREW };
}

// --- Sort helper: parse "DD.MM." to sortable int (MM*100+DD) ---
const CAT_ORDER = {transport:0,accommodation:1,lift:2,equipment:3,activity:4,food:5,drinks:6,other:7};
function dateSortKey(d) {
  const m = (d||"").match(/(\d{1,2})\.(\d{1,2})/);
  return m ? parseInt(m[2])*100+parseInt(m[1]) : 9999;
}
function sortExpenses(rows) {
  return rows.sort((a,b) => dateSortKey(a.date)-dateSortKey(b.date) || (CAT_ORDER[a.category]||7)-(CAT_ORDER[b.category]||7));
}

// --- API Routes ---
app.get("/api/expenses", (req, res) => {
  const expenses = db.prepare("SELECT id,date,person,what,amount,for_who,category,merchant,details,created_at,updated_at FROM expenses").all();
  res.json(sortExpenses(expenses));
});

app.post("/api/expenses", (req, res) => {
  const { person, what, amount, for_who, category, merchant, details, receipt_data, date: clientDate } = req.body;
  if (!person || !what || !amount) return res.status(400).json({ error: "person, what, amount required" });
  const date = clientDate || new Date().toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });
  const result = db.prepare(
    "INSERT INTO expenses (date, person, what, amount, for_who, category, merchant, details, receipt_data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(date, person, what, parseFloat(amount), for_who || "Reise", category || "other", merchant || null, details || null, receipt_data || null);
  const expense = db.prepare("SELECT id,date,person,what,amount,for_who,category,merchant,details,created_at FROM expenses WHERE id = ?").get(result.lastInsertRowid);
  
  db.prepare("INSERT INTO audit_log (action, entity_type, entity_id, description, actor) VALUES (?, ?, ?, ?, ?)")
    .run("create", "expense", expense.id, `${what} – ${parseFloat(amount).toFixed(2)}€ am ${date}${receipt_data ? " (mit Beleg)" : ""}`, person);
  
  res.status(201).json(expense);
});

app.put("/api/expenses/:id", (req, res) => {
  const old = db.prepare("SELECT * FROM expenses WHERE id = ?").get(req.params.id);
  if (!old) return res.status(404).json({ error: "Not found" });
  
  const { person, what, amount, for_who, category, merchant, details, date: clientDate } = req.body;
  const changes = [];
  if (what !== undefined && what !== old.what) changes.push(`Titel: "${old.what}" → "${what}"`);
  if (amount !== undefined && parseFloat(amount) !== old.amount) changes.push(`Betrag: ${old.amount.toFixed(2)}€ → ${parseFloat(amount).toFixed(2)}€`);
  if (person !== undefined && person !== old.person) changes.push(`Bezahlt von: ${old.person} → ${person}`);
  if (clientDate !== undefined && clientDate !== old.date) changes.push(`Datum: ${old.date} → ${clientDate}`);
  if (for_who !== undefined && for_who !== old.for_who) changes.push(`Aufteilung: ${old.for_who} → ${for_who}`);
  if (category !== undefined && category !== old.category) changes.push(`Kategorie: ${old.category} → ${category}`);
  if (merchant !== undefined && merchant !== old.merchant) changes.push(`Händler: ${old.merchant||"–"} → ${merchant||"–"}`);
  if (details !== undefined && details !== old.details) changes.push(`Details: geändert`);
  
  if (changes.length === 0) return res.json(old);
  
  db.prepare(`UPDATE expenses SET 
    date=?, person=?, what=?, amount=?, for_who=?, category=?, merchant=?, details=?,
    updated_at=datetime('now') WHERE id=?`
  ).run(
    clientDate || old.date, person || old.person, what || old.what, 
    amount !== undefined ? parseFloat(amount) : old.amount,
    for_who || old.for_who, category || old.category, 
    merchant !== undefined ? merchant : old.merchant,
    details !== undefined ? details : old.details,
    req.params.id
  );
  
  db.prepare("INSERT INTO audit_log (action, entity_type, entity_id, description, actor) VALUES (?, ?, ?, ?, ?)")
    .run("edit", "expense", parseInt(req.params.id), `${old.what}: ${changes.join(", ")}`, person || old.person);
  
  const updated = db.prepare("SELECT id,date,person,what,amount,for_who,category,merchant,details,created_at,updated_at FROM expenses WHERE id = ?").get(req.params.id);
  res.json(updated);
});

app.delete("/api/expenses/:id", (req, res) => {
  const expense = db.prepare("SELECT * FROM expenses WHERE id = ?").get(req.params.id);
  if (!expense) return res.status(404).json({ error: "Not found" });
  db.prepare("DELETE FROM expenses WHERE id = ?").run(req.params.id);
  db.prepare("INSERT INTO audit_log (action, entity_type, entity_id, description, actor) VALUES (?, ?, ?, ?, ?)")
    .run("delete", "expense", expense.id, `${expense.what} – ${expense.amount.toFixed(2)}€ gelöscht`, "user");
  res.json({ success: true });
});

app.get("/api/expenses/:id/receipt", (req, res) => {
  const row = db.prepare("SELECT receipt_data FROM expenses WHERE id = ?").get(req.params.id);
  if (!row || !row.receipt_data) return res.status(404).json({ error: "No receipt" });
  res.json({ receipt_data: row.receipt_data });
});

app.get("/api/transfers", (req, res) => res.json(db.prepare("SELECT * FROM transfers ORDER BY id ASC").all()));

app.post("/api/transfers", (req, res) => {
  const { from_person, to_person, amount, note } = req.body;
  if (!from_person || !to_person || !amount) return res.status(400).json({ error: "from_person, to_person, amount required" });
  const date = new Date().toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });
  const result = db.prepare("INSERT INTO transfers (date, from_person, to_person, amount, note) VALUES (?, ?, ?, ?, ?)").run(date, from_person, to_person, parseFloat(amount), note || "");
  const transfer = db.prepare("SELECT * FROM transfers WHERE id = ?").get(result.lastInsertRowid);
  db.prepare("INSERT INTO audit_log (action, entity_type, entity_id, description, actor) VALUES (?, ?, ?, ?, ?)")
    .run("create", "transfer", transfer.id, `${from_person} → ${to_person}: ${parseFloat(amount).toFixed(2)}€`, from_person);
  res.status(201).json(transfer);
});

app.delete("/api/transfers/:id", (req, res) => {
  const transfer = db.prepare("SELECT * FROM transfers WHERE id = ?").get(req.params.id);
  if (!transfer) return res.status(404).json({ error: "Not found" });
  db.prepare("DELETE FROM transfers WHERE id = ?").run(req.params.id);
  db.prepare("INSERT INTO audit_log (action, entity_type, entity_id, description, actor) VALUES (?, ?, ?, ?, ?)")
    .run("delete", "transfer", transfer.id, `${transfer.from_person} → ${transfer.to_person}: ${transfer.amount.toFixed(2)}€ gelöscht`, "user");
  res.json({ success: true });
});

app.get("/api/summary", (req, res) => res.json(calculateSettlement()));

app.get("/api/audit-log", (req, res) => {
  const log = db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT 100").all();
  res.json(log);
});

// --- Receipt AI Analysis ---
app.post("/api/receipts/analyze", async (req, res) => {
  if (!ANTHROPIC_KEY) return res.status(503).json({ error: "ANTHROPIC_API_KEY nicht konfiguriert" });
  const { image_base64, mime_type } = req.body;
  if (!image_base64) return res.status(400).json({ error: "image_base64 required" });
  
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514", max_tokens: 1000,
        messages: [{ role: "user", content: [
          { type: "image", source: { type: "base64", media_type: mime_type || "image/jpeg", data: image_base64 } },
          { type: "text", text: `Analysiere diesen Kassenbon/Beleg. Antworte NUR mit JSON (kein Markdown):
{"title":"Kurzbeschreibung","amount":123.45,"category":"transport|accommodation|food|equipment|activity|drinks|lift|other","date":"TT.MM.","details":"Positionen","merchant":"Geschäftsname"}` }
        ]}]
      })
    });
    const data = await resp.json();
    const text = (data.content || []).map(c => c.text || "").join("");
    const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
    res.json(parsed);
  } catch (e) {
    console.error("Receipt analysis error:", e.message);
    res.status(500).json({ error: "Analyse fehlgeschlagen", detail: e.message });
  }
});

// Webhook for n8n
app.get("/api/webhook/add", (req, res) => {
  const { person, betrag, was, fuer } = req.query;
  if (!person || !betrag || !was) return res.status(400).json({ error: "person, betrag, was required" });
  const date = new Date().toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });
  db.prepare("INSERT INTO expenses (date, person, what, amount, for_who) VALUES (?, ?, ?, ?, ?)").run(date, person, was, parseFloat(betrag), fuer || "Reise");
  res.json({ success: true });
});

app.get("/api/crew", (req, res) => res.json({ fullCrew: FULL_CREW, activeCrew: ACTIVE_CREW }));

app.listen(PORT, () => console.log(`🏂 Livigno Expenses v2 running on :${PORT}`));

// --- PDF Generation per Rider ---
app.get("/api/export/:person", (req, res) => {
  const person = decodeURIComponent(req.params.person);
  if (!FULL_CREW.includes(person)) return res.status(404).json({ error: "Person not found" });
  
  const settlement = calculateSettlement();
  const expenses = settlement.expenses;
  const transfers = settlement.transfers;
  
  // Expenses this person is involved in
  const myExpenses = expenses.filter(e => {
    const group = resolveForWho(e.for_who);
    return group.includes(person);
  }).map(e => {
    const group = resolveForWho(e.for_who);
    const myShare = e.amount / group.length;
    return { ...e, myShare, group, splitCount: group.length };
  });
  
  // Expenses this person paid
  const iPaid = expenses.filter(e => e.person === person);
  const totalPaid = iPaid.reduce((s, e) => s + e.amount, 0);
  const totalOwe = myExpenses.reduce((s, e) => s + e.myShare, 0);
  
  // Transfers
  const myTransfersOut = transfers.filter(t => t.from_person === person);
  const myTransfersIn = transfers.filter(t => t.to_person === person);
  const totalTransferredOut = myTransfersOut.reduce((s, t) => s + t.amount, 0);
  const totalTransferredIn = myTransfersIn.reduce((s, t) => s + t.amount, 0);
  
  const netBalance = totalPaid - totalOwe + totalTransferredOut - totalTransferredIn;
  const remaining = settlement.remainingTransfers.filter(t => t.from === person || t.to === person);
  
  res.json({
    person, 
    myExpenses, iPaid, 
    totalPaid, totalOwe,
    myTransfersOut, myTransfersIn,
    totalTransferredOut, totalTransferredIn,
    netBalance, remaining,
    totalGroupExpenses: settlement.totalExpenses,
    crew: FULL_CREW
  });
});
