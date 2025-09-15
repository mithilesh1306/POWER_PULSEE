require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const admin = require("firebase-admin");

// --- CONFIGURATION ---
const serviceAccount = require("./firebase-key.json");
const firebaseDatabaseURL = "https://test-001-c3444-default-rtdb.asia-southeast1.firebasedatabase.app";

const mysqlConfig = {
    host: 'localhost',
    user: 'root',
    password: process.env.DB_PASSWORD, // Uses the secure .env file
    database: 'energy_metrics'
};
const geminiAPIKey = process.env.GEMINI_API_KEY;

// --- INITIALIZATION ---
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: firebaseDatabaseURL
});
const db = admin.database();
const pool = mysql.createPool(mysqlConfig);
const genAI = new GoogleGenerativeAI(geminiAPIKey);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

const app = express();
const PORT = process.env.PORT || 3001;
app.use(cors());
app.use(express.json());

// --- HELPER FUNCTIONS (No changes needed here) ---
const calculateEnergy_kWh = (readings) => {
    let totalEnergy_Wh = 0;
    if (readings.length < 2) return 0;
    for (let i = 1; i < readings.length; i++) {
        const p1 = readings[i - 1];
        const p2 = readings[i];
        const avgPower_W = (p1.power_value + p2.power_value) / 2;
        const timeDiff_ms = new Date(p2.timestamp).getTime() - new Date(p1.timestamp).getTime();
        const timeDiff_h = timeDiff_ms / (1000 * 60 * 60);
        totalEnergy_Wh += avgPower_W * timeDiff_h;
    }
    return totalEnergy_Wh / 1000;
};
function calculateEBbill(totalUnits_kWh) {
    let billAmount = 0;
    if (totalUnits_kWh <= 100) billAmount = 0;
    else if (totalUnits_kWh <= 200) billAmount = (totalUnits_kWh - 100) * 2.25;
    else if (totalUnits_kWh <= 400) billAmount = (100 * 0) + (100 * 2.25) + ((totalUnits_kWh - 200) * 4.50);
    else if (totalUnits_kWh <= 500) billAmount = (100 * 0) + (100 * 2.25) + (200 * 4.50) + ((totalUnits_kWh - 400) * 6.00);
    else if (totalUnits_kWh <= 600) billAmount = (100 * 4.50) + (400 * 6.00) + ((totalUnits_kWh - 500) * 8.00);
    else if (totalUnits_kWh <= 800) billAmount = (100 * 4.50) + (100 * 6.00) + (200 * 8.00) + ((totalUnits_kWh - 600) * 9.00);
    else if (totalUnits_kWh <= 1000) billAmount = (100 * 4.50) + (100 * 6.00) + (200 * 8.00) + (200 * 9.00) + ((totalUnits_kWh - 800) * 10.00);
    else billAmount = (100 * 4.50) + (100 * 6.00) + (200 * 8.00) + (200 * 9.00) + (200 * 10.00) + ((totalUnits_kWh - 1000) * 11.00);
    return billAmount;
}
const saveDataToMySQL = async () => {
    try {
        const powerSnap = await db.ref('POWER').once('value');
        const currentSnap = await db.ref('CURRENT_DATA').once('value');
        const power = powerSnap.val() || 0;
        const current = currentSnap.val() || 0;
        const timestamp = new Date();
        if (power !== null && current !== null) {
            const sql = 'INSERT INTO energy_metrics (power_value, current_value, timestamp) VALUES (?, ?, ?)';
            await pool.execute(sql, [power, current, timestamp]);
            console.log(`[${timestamp.toLocaleTimeString()}] Saved to MySQL: Power=${power}W, Current=${current}A`);
        }
    } catch (error) { console.error('Error saving data to MySQL:', error.sqlMessage || error.message); }
};
setInterval(saveDataToMySQL, 30000);

// --- API ENDPOINTS (No changes needed here) ---
app.post('/register', async (req, res) => {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ message: 'All fields are required.' });
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        await pool.execute('INSERT INTO users (name, email, password) VALUES (?, ?, ?)', [name, email, hashedPassword]);
        res.status(201).json({ message: 'Registration successful! Please login.' });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'Email already exists.' });
        res.status(500).json({ message: 'Server error during registration.' });
    }
});
app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: 'Email and password are required.' });
    try {
        const [rows] = await pool.execute('SELECT * FROM users WHERE email = ?', [email]);
        if (rows.length === 0) return res.status(401).json({ message: 'Invalid email or password.' });
        const isMatch = await bcrypt.compare(password, rows[0].password);
        if (isMatch) res.status(200).json({ message: 'Login successful!' });
        else res.status(401).json({ message: 'Invalid email or password.' });
    } catch (error) { res.status(500).json({ message: 'An internal server error occurred.' }); }
});
app.get('/api/costs', async (req, res) => {
    try {
        const [todayReadings] = await pool.execute('SELECT power_value, timestamp FROM energy_metrics WHERE DATE(timestamp) = CURDATE() ORDER BY timestamp ASC');
        const costToday = calculateEBbill(calculateEnergy_kWh(todayReadings));
        const [monthReadings] = await pool.execute('SELECT power_value, timestamp FROM energy_metrics WHERE MONTH(timestamp) = MONTH(CURDATE()) AND YEAR(timestamp) = YEAR(CURDATE()) ORDER BY timestamp ASC');
        const costMonth = calculateEBbill(calculateEnergy_kWh(monthReadings));
        res.json({ cost_today: costToday.toFixed(2), cost_month: costMonth.toFixed(2) });
    } catch (error) { res.status(500).json({ error: 'Failed to fetch cost data.' }); }
});
app.get('/api/total-energy', async (req, res) => {
    const [readings] = await pool.execute('SELECT power_value, timestamp FROM energy_metrics');
    const totalEnergyWh = calculateEnergy_kWh(readings) * 1000;
    res.json({ totalEnergy: totalEnergyWh });
});
app.get('/api/charts/weekly-bill', async (req, res) => {
    try {
        const [readings] = await pool.execute('SELECT power_value, timestamp FROM energy_metrics WHERE timestamp >= CURDATE() - INTERVAL 7 DAY ORDER BY timestamp ASC');
        const dailyData = {};
        for (const r of readings) {
            const date = new Date(r.timestamp).toISOString().split('T')[0];
            if (!dailyData[date]) dailyData[date] = [];
            dailyData[date].push(r);
        }
        const labels = [], data = [];
        for (let i = 6; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const dateKey = d.toISOString().split('T')[0];
            labels.push(d.toLocaleDateString('en-US', { weekday: 'short' }));
            const bill = calculateEBbill(dailyData[dateKey] ? calculateEnergy_kWh(dailyData[dateKey]) : 0);
            data.push(bill.toFixed(2));
        }
        res.json({ labels, data });
    } catch (error) { res.status(500).json({ error: 'Failed to fetch chart data' }); }
});
app.get('/api/charts/power-history', async (req, res) => {
    const [readings] = await pool.execute('SELECT power_value, timestamp FROM energy_metrics ORDER BY timestamp DESC LIMIT 30');
    const labels = readings.reverse().map(r => new Date(r.timestamp).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }));
    const data = readings.map(r => r.power_value);
    res.json({ labels, data });
});
app.post('/api/ai-insight', async (req, res) => {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Prompt is required' });
    try {
        const result = await model.generateContent(prompt);
        res.json({ insight: result.response.text() });
    } catch (error) { res.status(500).json({ error: 'Failed to get a response from the AI.' }); }
});

app.listen(PORT, () => {
    console.log(`✅ Server is running on http://localhost:${PORT}`);
});