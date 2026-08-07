import { Hono } from "hono";

type Bindings = {
	DB: D1Database;
	SESSION_SECRET: string;
	SETUP_TOKEN: string;
};

type ItemInput = {
	link?: string;
	name?: string;
	unitPrice: number;
	quantity: number;
	notes?: string;
};

type Pricing = {
	markupRate: number;
	customsRate: number;
	deliveryRate: number;
	depositRate: number;
};

const app = new Hono<{ Bindings: Bindings }>();
const encoder = new TextEncoder();
const ORDER_STATUSES = [
	"Awaiting deposit verification",
	"Placed",
	"Purchased",
	"Shipped",
	"Customs",
	"Delivered",
] as const;

function jsonError(message: string, status = 400) {
	return new Response(JSON.stringify({ error: message }), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function randomToken(bytes = 24) {
	const values = new Uint8Array(bytes);
	crypto.getRandomValues(values);
	return btoa(String.fromCharCode(...values))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll("=", "");
}

function orderCode() {
	const number = Math.floor(100000 + Math.random() * 900000);
	return `LR-${number}-ZW`;
}

function numberValue(value: unknown, fallback = 0) {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function quote(items: ItemInput[], pricing: Pricing, deliveryMethod: string) {
	const subtotal = items.reduce(
		(sum, item) => sum + numberValue(item.unitPrice) * numberValue(item.quantity),
		0,
	);
	const markup = subtotal * (pricing.markupRate / 100);
	const customs = subtotal * (pricing.customsRate / 100);
	const beforeDelivery = subtotal + markup + customs;
	const delivery = deliveryMethod === "delivery" ? beforeDelivery * (pricing.deliveryRate / 100) : 0;
	const total = beforeDelivery + delivery;
	const deposit = total * (pricing.depositRate / 100);
	return {
		subtotal,
		markup,
		customs,
		delivery,
		total,
		deposit,
		balance: total - deposit,
	};
}

async function getPricing(db: D1Database): Promise<Pricing> {
	const row = await db
		.prepare("SELECT markup_rate, customs_rate, delivery_rate, deposit_rate FROM pricing_rules WHERE id = 1")
		.first<{ markup_rate: number; customs_rate: number; delivery_rate: number; deposit_rate: number }>();
	return {
		markupRate: numberValue(row?.markup_rate, 6),
		customsRate: numberValue(row?.customs_rate, 10),
		deliveryRate: numberValue(row?.delivery_rate, 30),
		depositRate: numberValue(row?.deposit_rate, 40),
	};
}

function base64Url(text: string) {
	return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function decodeBase64Url(value: string) {
	const normal = value.replaceAll("-", "+").replaceAll("_", "/");
	return atob(normal + "=".repeat((4 - (normal.length % 4)) % 4));
}

async function hmac(value: string, secret: string) {
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
	return base64Url(String.fromCharCode(...new Uint8Array(signature)));
}

async function createSession(admin: { id: number; email: string }, secret: string) {
	const payload = base64Url(JSON.stringify({ sub: admin.id, email: admin.email, exp: Date.now() + 86_400_000 }));
	return `${payload}.${await hmac(payload, secret)}`;
}

async function readSession(request: Request, secret: string) {
	const cookie = request.headers.get("cookie") || "";
	const token = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("lr_session="))?.slice(11);
	if (!token) return null;
	const [payload, signature] = token.split(".");
	if (!payload || !signature || signature !== (await hmac(payload, secret))) return null;
	try {
		const data = JSON.parse(decodeBase64Url(payload)) as { sub: number; email: string; exp: number };
		return data.exp > Date.now() ? data : null;
	} catch {
		return null;
	}
}

async function passwordHash(password: string, salt: string) {
	const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
	const bits = await crypto.subtle.deriveBits(
		{ name: "PBKDF2", hash: "SHA-256", salt: encoder.encode(salt), iterations: 100_000 },
		key,
		256,
	);
	return base64Url(String.fromCharCode(...new Uint8Array(bits)));
}

async function requireAdmin(request: Request, bindings: Bindings) {
	const session = await readSession(request, bindings.SESSION_SECRET);
	return session;
}

app.get("/api/health", (c) => c.json({ ok: true }));

app.get("/api/pricing", async (c) => c.json(await getPricing(c.env.DB)));

app.post("/api/orders", async (c) => {
	let body: {
		customerName?: string;
		customerPhone?: string;
		deliveryMethod?: string;
		deliveryAddress?: string;
		paymentReference?: string;
		items?: ItemInput[];
	};
	try {
		body = await c.req.json();
	} catch {
		return jsonError("Please send a valid order.");
	}

	const customerName = String(body.customerName || "").trim();
	const customerPhone = String(body.customerPhone || "").trim();
	const deliveryMethod = body.deliveryMethod === "delivery" ? "delivery" : "collection";
	const deliveryAddress = String(body.deliveryAddress || "").trim();
	const paymentReference = String(body.paymentReference || "").trim();
	const items = Array.isArray(body.items) ? body.items : [];

	if (!customerName || !customerPhone) return jsonError("Name and WhatsApp number are required.");
	if (items.length < 1 || items.length > 10) return jsonError("An order must contain between 1 and 10 products.");
	if (deliveryMethod === "delivery" && !deliveryAddress) return jsonError("Please enter a delivery address.");
	if (!paymentReference || paymentReference.length < 4) return jsonError("Enter the payment reference before submitting.");
	for (const item of items) {
		if ((!item.link && !item.name) || numberValue(item.unitPrice) <= 0 || numberValue(item.quantity) < 1) {
			return jsonError("Every product needs a link or name, price, and quantity.");
		}
	}

	const pricing = await getPricing(c.env.DB);
	const totals = quote(items, pricing, deliveryMethod);
	const createdAt = new Date().toISOString();
	const trackingToken = randomToken();
	let code = orderCode();
	for (let attempt = 0; attempt < 3; attempt++) {
		const exists = await c.env.DB.prepare("SELECT id FROM orders WHERE order_code = ?").bind(code).first();
		if (!exists) break;
		code = orderCode();
	}

	const orderResult = await c.env.DB
		.prepare(
			`INSERT INTO orders (
				order_code, tracking_token, customer_name, customer_phone, delivery_method, delivery_address,
				payment_reference, status, subtotal, markup_amount, customs_amount, delivery_amount,
				total_amount, deposit_amount, balance_amount, markup_rate, customs_rate, delivery_rate,
				deposit_rate, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			code,
			trackingToken,
			customerName,
			customerPhone,
			deliveryMethod,
			deliveryAddress || null,
			paymentReference,
			"Awaiting deposit verification",
			totals.subtotal,
			totals.markup,
			totals.customs,
			totals.delivery,
			totals.total,
			totals.deposit,
			totals.balance,
			pricing.markupRate,
			pricing.customsRate,
			pricing.deliveryRate,
			pricing.depositRate,
			createdAt,
			createdAt,
		)
		.run();
	const orderId = Number(orderResult.meta.last_row_id);
	const statements = items.flatMap((item) => [
		c.env.DB
			.prepare("INSERT INTO order_items (order_id, product_link, product_name, unit_price, quantity, notes) VALUES (?, ?, ?, ?, ?, ?)")
			.bind(orderId, String(item.link || "").trim() || null, String(item.name || "").trim() || null, numberValue(item.unitPrice), numberValue(item.quantity), String(item.notes || "").trim() || null),
	]);
	statements.push(
		c.env.DB
			.prepare("INSERT INTO order_events (order_id, status, note, created_at) VALUES (?, ?, ?, ?)")
			.bind(orderId, "Awaiting deposit verification", "Order submitted by customer", createdAt),
	);
	await c.env.DB.batch(statements);

	return c.json({
		orderCode: code,
		trackingToken,
		status: "Awaiting deposit verification",
		pricing,
		totals,
	});
});

app.get("/api/track/:code", async (c) => {
	const token = c.req.query("token");
	if (!token) return jsonError("Tracking token is required.", 401);
	const order = await c.env.DB
		.prepare("SELECT order_code, status, delivery_method, total_amount, deposit_amount, balance_amount, updated_at FROM orders WHERE order_code = ? AND tracking_token = ?")
		.bind(c.req.param("code"), token)
		.first();
	if (!order) return jsonError("Order not found.", 404);
	return c.json(order);
});

app.post("/api/auth/bootstrap", async (c) => {
	const admins = await c.env.DB.prepare("SELECT COUNT(*) AS count FROM admins").first<{ count: number }>();
	if (numberValue(admins?.count) > 0) return jsonError("An administrator already exists.", 409);
	const body = await c.req.json<{ email?: string; password?: string; setupToken?: string }>();
	const email = String(body.email || "").trim().toLowerCase();
	const password = String(body.password || "");
	if (body.setupToken !== c.env.SETUP_TOKEN) return jsonError("Invalid setup token.", 401);
	if (!email.includes("@") || password.length < 12) return jsonError("Use a valid email and a password with at least 12 characters.");
	const salt = randomToken(16);
	const hash = await passwordHash(password, salt);
	const createdAt = new Date().toISOString();
	const result = await c.env.DB.prepare("INSERT INTO admins (email, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?)").bind(email, hash, salt, createdAt).run();
	const session = await createSession({ id: Number(result.meta.last_row_id), email }, c.env.SESSION_SECRET);
	c.header("Set-Cookie", `lr_session=${session}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`);
	return c.json({ ok: true, email });
});

app.post("/api/auth/login", async (c) => {
	const body = await c.req.json<{ email?: string; password?: string }>();
	const email = String(body.email || "").trim().toLowerCase();
	const password = String(body.password || "");
	const admin = await c.env.DB.prepare("SELECT id, email, password_hash, password_salt FROM admins WHERE email = ?").bind(email).first<{ id: number; email: string; password_hash: string; password_salt: string }>();
	if (!admin || (await passwordHash(password, admin.password_salt)) !== admin.password_hash) return jsonError("Incorrect email or password.", 401);
	const session = await createSession({ id: admin.id, email: admin.email }, c.env.SESSION_SECRET);
	c.header("Set-Cookie", `lr_session=${session}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`);
	return c.json({ ok: true, email: admin.email });
});

app.post("/api/auth/logout", (c) => {
	c.header("Set-Cookie", "lr_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
	return c.json({ ok: true });
});

app.get("/api/admin/pricing", async (c) => {
	if (!(await requireAdmin(c.req.raw, c.env))) return jsonError("Sign in required.", 401);
	return c.json(await getPricing(c.env.DB));
});

app.put("/api/admin/pricing", async (c) => {
	if (!(await requireAdmin(c.req.raw, c.env))) return jsonError("Sign in required.", 401);
	const body = await c.req.json<Partial<Pricing>>();
	const pricing: Pricing = {
		markupRate: Math.max(0, numberValue(body.markupRate)),
		customsRate: Math.max(0, numberValue(body.customsRate)),
		deliveryRate: Math.max(0, numberValue(body.deliveryRate)),
		depositRate: Math.max(0, numberValue(body.depositRate)),
	};
	await c.env.DB.prepare("UPDATE pricing_rules SET markup_rate = ?, customs_rate = ?, delivery_rate = ?, deposit_rate = ?, updated_at = ? WHERE id = 1").bind(pricing.markupRate, pricing.customsRate, pricing.deliveryRate, pricing.depositRate, new Date().toISOString()).run();
	return c.json(pricing);
});

app.get("/api/admin/orders", async (c) => {
	if (!(await requireAdmin(c.req.raw, c.env))) return jsonError("Sign in required.", 401);
	const orders = await c.env.DB.prepare("SELECT id, order_code, customer_name, customer_phone, delivery_method, payment_reference, status, total_amount, deposit_amount, balance_amount, created_at, updated_at FROM orders ORDER BY created_at DESC").all();
	const items = await c.env.DB.prepare("SELECT order_id, product_link, product_name, unit_price, quantity, notes FROM order_items ORDER BY id").all();
	return c.json({
		orders: orders.results.map((order) => ({ ...order, items: items.results.filter((item) => item.order_id === order.id) })),
	});
});

app.patch("/api/admin/orders/:id/status", async (c) => {
	const session = await requireAdmin(c.req.raw, c.env);
	if (!session) return jsonError("Sign in required.", 401);
	const body = await c.req.json<{ status?: string; note?: string }>();
	if (!ORDER_STATUSES.includes(body.status as (typeof ORDER_STATUSES)[number])) return jsonError("Invalid order status.");
	const id = Number(c.req.param("id"));
	const now = new Date().toISOString();
	await c.env.DB.prepare("UPDATE orders SET status = ?, updated_at = ? WHERE id = ?").bind(body.status, now, id).run();
	await c.env.DB.prepare("INSERT INTO order_events (order_id, status, note, created_at) VALUES (?, ?, ?, ?)").bind(id, body.status, String(body.note || "Status changed by admin"), now).run();
	return c.json({ ok: true });
});

export default app;
