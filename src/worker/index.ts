import { Hono } from "hono";

type Bindings = {
	DB: D1Database;
	SESSION_SECRET: string;
	SETUP_TOKEN: string;
};

type ItemInput = {
	id?: number;
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

const STATUS = {
	priceReview: "Awaiting price verification",
	quoteAcceptance: "Awaiting customer quote acceptance",
	deposit: "Awaiting deposit",
	depositVerification: "Awaiting deposit verification",
	placed: "Placed",
	purchased: "Purchased",
	shipped: "Shipped",
	customs: "Customs",
	outForDelivery: "Out for delivery",
	delivered: "Delivered",
	cancelled: "Cancelled",
	refundPending: "Refund pending",
	refunded: "Refunded",
} as const;

const VALID_STATUSES = Object.values(STATUS);

function jsonError(message: string, status = 400) {
	return new Response(JSON.stringify({ error: message }), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function randomToken(bytes = 24) {
	const values = new Uint8Array(bytes);
	crypto.getRandomValues(values);
	return btoa(String.fromCharCode(...values)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function orderCode() {
	const number = Math.floor(100000 + Math.random() * 900000);
	return `LR-${number}-ZW`;
}

function numberValue(value: unknown, fallback = 0) {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function asBoolean(value: unknown) {
	return value === true || value === 1 || value === "true";
}

function quote(items: ItemInput[], pricing: Pricing, deliveryMethod: string) {
	const subtotal = items.reduce((sum, item) => sum + numberValue(item.unitPrice) * numberValue(item.quantity), 0);
	const markup = subtotal * (pricing.markupRate / 100);
	const customs = subtotal * (pricing.customsRate / 100);
	const beforeDelivery = subtotal + markup + customs;
	const delivery = deliveryMethod === "delivery" ? beforeDelivery * (pricing.deliveryRate / 100) : 0;
	const total = beforeDelivery + delivery;
	const deposit = total * (pricing.depositRate / 100);
	return { subtotal, markup, customs, delivery, total, deposit, balance: total - deposit };
}

function rateSnapshot(row: Record<string, unknown>): Pricing {
	return {
		markupRate: numberValue(row.markup_rate, 6),
		customsRate: numberValue(row.customs_rate, 10),
		deliveryRate: numberValue(row.delivery_rate, 30),
		depositRate: numberValue(row.deposit_rate, 40),
	};
}

async function getPricing(db: D1Database): Promise<Pricing> {
	const row = await db.prepare("SELECT markup_rate, customs_rate, delivery_rate, deposit_rate FROM pricing_rules WHERE id = 1").first<Record<string, unknown>>();
	return rateSnapshot(row || {});
}

function base64Url(text: string) {
	return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function decodeBase64Url(value: string) {
	const normal = value.replace(/-/g, "+").replace(/_/g, "/");
	return atob(normal + "=".repeat((4 - (normal.length % 4)) % 4));
}

async function hmac(value: string, secret: string) {
	const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
	return base64Url(String.fromCharCode(...new Uint8Array(signature)));
}

async function createSession(admin: { id: number; email: string; role: string }, secret: string) {
	const payload = base64Url(JSON.stringify({ sub: admin.id, email: admin.email, role: admin.role, exp: Date.now() + 86_400_000 }));
	return `${payload}.${await hmac(payload, secret)}`;
}

async function readSession(request: Request, secret: string) {
	const cookie = request.headers.get("cookie") || "";
	const token = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("lr_session="))?.slice(11);
	if (!token) return null;
	const [payload, signature] = token.split(".");
	if (!payload || !signature || signature !== (await hmac(payload, secret))) return null;
	try {
		const data = JSON.parse(decodeBase64Url(payload)) as { sub: number; email: string; role: string; exp: number };
		return data.exp > Date.now() ? data : null;
	} catch {
		return null;
	}
}

async function passwordHash(password: string, salt: string) {
	const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
	const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: encoder.encode(salt), iterations: 100_000 }, key, 256);
	return base64Url(String.fromCharCode(...new Uint8Array(bits)));
}

async function requireAdmin(request: Request, bindings: Bindings) {
	return readSession(request, bindings.SESSION_SECRET);
}

async function addEvent(db: D1Database, orderId: number, status: string, note: string, actorEmail?: string) {
	await db.prepare("INSERT INTO order_events (order_id, status, note, actor_email, created_at) VALUES (?, ?, ?, ?, ?)").bind(orderId, status, note, actorEmail || null, new Date().toISOString()).run();
}

app.get("/api/health", (c) => c.json({ ok: true }));
app.get("/api/pricing", async (c) => c.json(await getPricing(c.env.DB)));

app.post("/api/orders", async (c) => {
	let body: {
		customerName?: string;
		customerPhone?: string;
		deliveryMethod?: string;
		deliveryAddress?: string;
		items?: ItemInput[];
		customerConsent?: boolean;
		whatsappConsent?: boolean;
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
	const items = Array.isArray(body.items) ? body.items : [];
	const customerConsent = asBoolean(body.customerConsent);
	const whatsappConsent = asBoolean(body.whatsappConsent);

	if (!customerName || !customerPhone) return jsonError("Name and WhatsApp number are required.");
	if (!customerConsent) return jsonError("Please accept the order terms and privacy notice.");
	if (items.length < 1 || items.length > 10) return jsonError("An order must contain between 1 and 10 products.");
	if (deliveryMethod === "delivery" && !deliveryAddress) return jsonError("Please enter a delivery address.");
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
	for (let attempt = 0; attempt < 4; attempt++) {
		const exists = await c.env.DB.prepare("SELECT id FROM orders WHERE order_code = ?").bind(code).first();
		if (!exists) break;
		code = orderCode();
	}

	const orderResult = await c.env.DB.prepare(
		`INSERT INTO orders (
			order_code, tracking_token, customer_name, customer_phone, delivery_method, delivery_address,
			payment_reference, status, quote_status, customer_consent, whatsapp_consent,
			subtotal, markup_amount, customs_amount, delivery_amount, total_amount, deposit_amount, balance_amount,
			markup_rate, customs_rate, delivery_rate, deposit_rate, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	).bind(
		code, trackingToken, customerName, customerPhone, deliveryMethod, deliveryAddress || null,
		"", STATUS.priceReview, "pending", customerConsent ? 1 : 0, whatsappConsent ? 1 : 0,
		totals.subtotal, totals.markup, totals.customs, totals.delivery, totals.total, totals.deposit, totals.balance,
		pricing.markupRate, pricing.customsRate, pricing.deliveryRate, pricing.depositRate, createdAt, createdAt,
	).run();
	const orderId = Number(orderResult.meta.last_row_id);
	await c.env.DB.batch(items.map((item) => c.env.DB.prepare(
		"INSERT INTO order_items (order_id, product_link, product_name, unit_price, quantity, notes) VALUES (?, ?, ?, ?, ?, ?)"
	).bind(orderId, String(item.link || "").trim() || null, String(item.name || "").trim() || null, numberValue(item.unitPrice), numberValue(item.quantity), String(item.notes || "").trim() || null)));
	await addEvent(c.env.DB, orderId, STATUS.priceReview, "Customer submitted order request");

	return c.json({ orderCode: code, trackingToken, status: STATUS.priceReview, pricing, totals });
});

app.get("/api/track/:code", async (c) => {
	const token = c.req.query("token");
	if (!token) return jsonError("Tracking token is required.", 401);
	const order = await c.env.DB.prepare(
		`SELECT id, order_code, status, quote_status, delivery_method, delivery_address, total_amount, deposit_amount,
		balance_amount, payment_reference, final_quote_note, updated_at, quote_accepted_at FROM orders WHERE order_code = ? AND tracking_token = ?`
	).bind(c.req.param("code"), token).first<Record<string, unknown>>();
	if (!order) return jsonError("Order not found.", 404);
	const items = await c.env.DB.prepare("SELECT id, product_link, product_name, unit_price, quantity, notes FROM order_items WHERE order_id = ? ORDER BY id").bind(order.id).all<Record<string, unknown>>();
	const events = await c.env.DB.prepare("SELECT status, note, created_at FROM order_events WHERE order_id = ? ORDER BY id DESC").bind(order.id).all();
	return c.json({ ...order, items: items.results.map((item) => ({ id: item.id, link: item.product_link || "", name: item.product_name || "", unitPrice: item.unit_price, quantity: item.quantity, notes: item.notes || "" })), events: events.results });
});

app.post("/api/track/:code/accept-quote", async (c) => {
	const body = await c.req.json<{ token?: string }>();
	const order = await c.env.DB.prepare("SELECT id, status FROM orders WHERE order_code = ? AND tracking_token = ?").bind(c.req.param("code"), body.token || "").first<{ id: number; status: string }>();
	if (!order) return jsonError("Order not found.", 404);
	if (order.status !== STATUS.quoteAcceptance) return jsonError("This quote is not awaiting acceptance.");
	const now = new Date().toISOString();
	await c.env.DB.prepare("UPDATE orders SET status = ?, quote_status = ?, quote_accepted_at = ?, updated_at = ? WHERE id = ?").bind(STATUS.deposit, "accepted", now, now, order.id).run();
	await addEvent(c.env.DB, order.id, STATUS.deposit, "Customer accepted the final quote");
	return c.json({ ok: true, status: STATUS.deposit });
});

app.post("/api/track/:code/payment", async (c) => {
	const body = await c.req.json<{ token?: string; paymentReference?: string }>();
	const paymentReference = String(body.paymentReference || "").trim();
	const order = await c.env.DB.prepare("SELECT id, status FROM orders WHERE order_code = ? AND tracking_token = ?").bind(c.req.param("code"), body.token || "").first<{ id: number; status: string }>();
	if (!order) return jsonError("Order not found.", 404);
	if (order.status !== STATUS.deposit) return jsonError("A deposit reference can only be sent after accepting the final quote.");
	if (paymentReference.length < 4) return jsonError("Enter a valid payment reference.");
	const now = new Date().toISOString();
	await c.env.DB.prepare("UPDATE orders SET payment_reference = ?, status = ?, updated_at = ? WHERE id = ?").bind(paymentReference, STATUS.depositVerification, now, order.id).run();
	await addEvent(c.env.DB, order.id, STATUS.depositVerification, "Customer supplied deposit payment reference");
	return c.json({ ok: true, status: STATUS.depositVerification });
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
	const result = await c.env.DB.prepare("INSERT INTO admins (email, password_hash, password_salt, role, created_at) VALUES (?, ?, ?, ?, ?)").bind(email, hash, salt, "owner", createdAt).run();
	const session = await createSession({ id: Number(result.meta.last_row_id), email, role: "owner" }, c.env.SESSION_SECRET);
	c.header("Set-Cookie", `lr_session=${session}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`);
	return c.json({ ok: true, email });
});

app.post("/api/auth/login", async (c) => {
	const body = await c.req.json<{ email?: string; password?: string }>();
	const email = String(body.email || "").trim().toLowerCase();
	const password = String(body.password || "");
	const admin = await c.env.DB.prepare("SELECT id, email, password_hash, password_salt, role FROM admins WHERE email = ?").bind(email).first<{ id: number; email: string; password_hash: string; password_salt: string; role: string }>();
	if (!admin || (await passwordHash(password, admin.password_salt)) !== admin.password_hash) return jsonError("Incorrect email or password.", 401);
	const session = await createSession(admin, c.env.SESSION_SECRET);
	c.header("Set-Cookie", `lr_session=${session}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`);
	return c.json({ ok: true, email: admin.email, role: admin.role });
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
		markupRate: Math.max(0, numberValue(body.markupRate)), customsRate: Math.max(0, numberValue(body.customsRate)),
		deliveryRate: Math.max(0, numberValue(body.deliveryRate)), depositRate: Math.max(0, numberValue(body.depositRate)),
	};
	await c.env.DB.prepare("UPDATE pricing_rules SET markup_rate = ?, customs_rate = ?, delivery_rate = ?, deposit_rate = ?, updated_at = ? WHERE id = 1").bind(pricing.markupRate, pricing.customsRate, pricing.deliveryRate, pricing.depositRate, new Date().toISOString()).run();
	return c.json(pricing);
});

app.get("/api/admin/orders", async (c) => {
	if (!(await requireAdmin(c.req.raw, c.env))) return jsonError("Sign in required.", 401);
	const orders = await c.env.DB.prepare(
		`SELECT id, order_code, customer_name, customer_phone, delivery_method, payment_reference, status, quote_status,
		total_amount, deposit_amount, balance_amount, final_quote_note, refund_amount, refund_status, created_at, updated_at FROM orders ORDER BY created_at DESC`
	).all();
	const items = await c.env.DB.prepare("SELECT id, order_id, product_link, product_name, unit_price, quantity, notes FROM order_items ORDER BY id").all<Record<string, unknown>>();
	const events = await c.env.DB.prepare("SELECT order_id, status, note, actor_email, created_at FROM order_events ORDER BY id DESC").all();
	return c.json({ orders: orders.results.map((order) => ({ ...order, items: items.results.filter((item) => item.order_id === order.id).map((item) => ({ id: item.id, link: item.product_link || "", name: item.product_name || "", unitPrice: item.unit_price, quantity: item.quantity, notes: item.notes || "" })), events: events.results.filter((event) => event.order_id === order.id) })) });
});

app.put("/api/admin/orders/:id/quote", async (c) => {
	const admin = await requireAdmin(c.req.raw, c.env);
	if (!admin) return jsonError("Sign in required.", 401);
	const body = await c.req.json<{ items?: ItemInput[]; finalQuoteNote?: string }>();
	const orderId = Number(c.req.param("id"));
	const order = await c.env.DB.prepare("SELECT id, status, delivery_method, markup_rate, customs_rate, delivery_rate, deposit_rate FROM orders WHERE id = ?").bind(orderId).first<Record<string, unknown>>();
	if (!order) return jsonError("Order not found.", 404);
	if (order.status !== STATUS.priceReview) return jsonError("Only orders awaiting price verification can be quoted.");
	const items = Array.isArray(body.items) ? body.items : [];
	if (items.length < 1 || items.length > 10) return jsonError("Add valid items to the verified quote.");
	for (const item of items) {
		if (!item.id || numberValue(item.unitPrice) <= 0 || numberValue(item.quantity) < 1) return jsonError("Every verified product needs a price and quantity.");
	}
	const totals = quote(items, rateSnapshot(order), String(order.delivery_method));
	const now = new Date().toISOString();
	await c.env.DB.batch(items.map((item) => c.env.DB.prepare("UPDATE order_items SET unit_price = ?, quantity = ?, product_link = ?, product_name = ?, notes = ? WHERE id = ? AND order_id = ?").bind(
		numberValue(item.unitPrice), numberValue(item.quantity), String(item.link || "").trim() || null, String(item.name || "").trim() || null, String(item.notes || "").trim() || null, item.id, orderId
	)));
	await c.env.DB.prepare(
		`UPDATE orders SET status = ?, quote_status = ?, final_quote_note = ?, subtotal = ?, markup_amount = ?, customs_amount = ?, delivery_amount = ?, total_amount = ?, deposit_amount = ?, balance_amount = ?, price_verified_at = ?, price_verified_by = ?, updated_at = ? WHERE id = ?`
	).bind(STATUS.quoteAcceptance, "issued", String(body.finalQuoteNote || "").trim() || null, totals.subtotal, totals.markup, totals.customs, totals.delivery, totals.total, totals.deposit, totals.balance, now, admin.sub, now, orderId).run();
	await addEvent(c.env.DB, orderId, STATUS.quoteAcceptance, "Staff verified item prices and issued final quote", admin.email);
	return c.json({ ok: true, status: STATUS.quoteAcceptance, totals });
});

app.patch("/api/admin/orders/:id/status", async (c) => {
	const admin = await requireAdmin(c.req.raw, c.env);
	if (!admin) return jsonError("Sign in required.", 401);
	const body = await c.req.json<{ status?: string; note?: string; refundAmount?: number }>();
	const status = String(body.status || "");
	if (!VALID_STATUSES.includes(status as (typeof VALID_STATUSES)[number])) return jsonError("Invalid order status.");
	const orderId = Number(c.req.param("id"));
	const current = await c.env.DB.prepare("SELECT id, status FROM orders WHERE id = ?").bind(orderId).first<{ id: number; status: string }>();
	if (!current) return jsonError("Order not found.", 404);
	if (current.status === STATUS.priceReview && status !== STATUS.cancelled) return jsonError("Verify and issue the quote before moving this order forward.");
	if (current.status === STATUS.quoteAcceptance && status !== STATUS.cancelled && status !== STATUS.refundPending) return jsonError("Wait for customer quote acceptance before moving this order forward.");
	if (current.status === STATUS.deposit && status !== STATUS.depositVerification && status !== STATUS.cancelled) return jsonError("Wait for customer payment reference before moving this order forward.");
	if (current.status === STATUS.depositVerification && status !== STATUS.placed && status !== STATUS.cancelled && status !== STATUS.refundPending) return jsonError("Verify payment before moving the order forward.");
	const now = new Date().toISOString();
	const paymentVerifiedAt = status === STATUS.placed ? now : null;
	const refundAmount = Math.max(0, numberValue(body.refundAmount));
	const refundStatus = status === STATUS.refundPending ? "pending" : status === STATUS.refunded ? "completed" : null;
	await c.env.DB.prepare("UPDATE orders SET status = ?, payment_verified_at = COALESCE(?, payment_verified_at), payment_verified_by = COALESCE(?, payment_verified_by), refund_amount = CASE WHEN ? > 0 THEN ? ELSE refund_amount END, refund_status = COALESCE(?, refund_status), cancel_reason = CASE WHEN ? = ? THEN ? ELSE cancel_reason END, updated_at = ? WHERE id = ?").bind(
		status, paymentVerifiedAt, status === STATUS.placed ? admin.sub : null, refundAmount, refundAmount, refundStatus, status, STATUS.cancelled, String(body.note || "").trim() || null, now, orderId
	).run();
	await addEvent(c.env.DB, orderId, status, String(body.note || "Status changed by staff"), admin.email);
	return c.json({ ok: true, status });
});

export default app;
