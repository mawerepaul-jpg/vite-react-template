import { Hono } from "hono";

type Bindings = {
	DB: D1Database;
	SESSION_SECRET: string;
	SETUP_TOKEN: string;
	WHATSAPP_ACCESS_TOKEN?: string;
	WHATSAPP_PHONE_NUMBER_ID?: string;
	WHATSAPP_TEST_RECIPIENT?: string;
	WHATSAPP_MODE?: string;
	WHATSAPP_TEMPLATE_NAME?: string;
	WHATSAPP_TEMPLATE_LANGUAGE?: string;
	WHATSAPP_WEBHOOK_VERIFY_TOKEN?: string;
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

function normalizeWhatsAppNumber(phone: string) {
	const digits = String(phone || "").replace(/\D/g, "");
	if (digits.startsWith("0")) return `263${digits.slice(1)}`;
	return digits;
}

function statusText(status: string) {
	const messages: Record<string, string> = {
		[STATUS.quoteAcceptance]: "Your final quote is ready. Please review and accept it using your private tracking link.",
		[STATUS.deposit]: "Your final quote was accepted. Please pay the required deposit and submit the payment reference through your private tracking link.",
		[STATUS.depositVerification]: "Your payment reference was received and is being checked by LELE Runner.",
		[STATUS.placed]: "Your payment was verified. LELE Runner has placed your order.",
		[STATUS.purchased]: "Your items have been purchased from the supplier.",
		[STATUS.shipped]: "Your order has been shipped and is moving to Zimbabwe.",
		[STATUS.customs]: "Your order is in the customs process.",
		[STATUS.outForDelivery]: "Your parcel is out for delivery.",
		[STATUS.delivered]: "Thank you for using LELE Runner. Your order was successfully delivered.",
		[STATUS.cancelled]: "Your order was cancelled. Please contact LELE Runner if you need assistance.",
		[STATUS.refundPending]: "Your refund is being processed.",
		[STATUS.refunded]: "Your refund has been completed. Thank you for your patience.",
	};
	return messages[status] || `Your order status is now: ${status}.`;
}

async function logWhatsApp(db: D1Database, orderId: number | null, recipient: string, eventStatus: string, state: string, templateName: string, response: string, providerMessageId?: string | null, error?: string | null) {
	await db.prepare("INSERT INTO whatsapp_notifications (order_id, recipient, event_status, delivery_state, template_name, provider_message_id, provider_response, error_message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(orderId, recipient, eventStatus, state, templateName, providerMessageId || null, response || null, error || null, new Date().toISOString()).run();
}

async function sendWhatsAppStatus(env: Bindings, order: { id: number; order_code: string; customer_phone: string; whatsapp_consent: number | boolean }, status: string) {
	if (!order.whatsapp_consent) {
		await logWhatsApp(env.DB, order.id, normalizeWhatsAppNumber(order.customer_phone), status, "skipped", "consent_required", "Customer did not opt in to WhatsApp updates");
		return { sent: false, reason: "no consent" };
	}
	if (!env.WHATSAPP_ACCESS_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) {
		await logWhatsApp(env.DB, order.id, normalizeWhatsAppNumber(order.customer_phone), status, "skipped", "not_configured", "WhatsApp API secrets are not configured");
		return { sent: false, reason: "not configured" };
	}
	const testMode = env.WHATSAPP_MODE === "test";
	const recipient = testMode ? normalizeWhatsAppNumber(env.WHATSAPP_TEST_RECIPIENT || "") : normalizeWhatsAppNumber(order.customer_phone);
	if (!recipient) return { sent: false, reason: "no recipient" };
	const templateName = testMode ? "hello_world" : (env.WHATSAPP_TEMPLATE_NAME || "order_status_update");
	const message = testMode ? {
		messaging_product: "whatsapp", to: recipient, type: "template", template: { name: "hello_world", language: { code: "en_US" } }
	} : {
		messaging_product: "whatsapp", to: recipient, type: "template", template: {
			name: templateName, language: { code: env.WHATSAPP_TEMPLATE_LANGUAGE || "en" }, components: [{ type: "body", parameters: [
				{ type: "text", parameter_name: "order_id", text: order.order_code },
				{ type: "text", parameter_name: "order_status", text: status },
				{ type: "text", parameter_name: "update_message", text: statusText(status) }
			] }]
		}
	};
	try {
		const result = await fetch(`https://graph.facebook.com/v26.0/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
			method: "POST", headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(message),
		});
		const raw = await result.text();
		let providerMessageId: string | null = null;
		try { providerMessageId = JSON.parse(raw)?.messages?.[0]?.id || null; } catch { /* raw response retained below */ }
		await logWhatsApp(env.DB, order.id, recipient, status, result.ok ? "sent" : "failed", templateName, raw, providerMessageId, result.ok ? null : raw);
		return { sent: result.ok, response: raw };
	} catch (error) {
		const messageText = error instanceof Error ? error.message : "WhatsApp request failed";
		await logWhatsApp(env.DB, order.id, recipient, status, "failed", templateName, "", null, messageText);
		return { sent: false, reason: messageText };
	}
}

async function sendWhatsAppTest(env: Bindings) {
	if (!env.WHATSAPP_ACCESS_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID || !env.WHATSAPP_TEST_RECIPIENT) return { sent: false, reason: "WhatsApp test secrets are incomplete." };
	const recipient = normalizeWhatsAppNumber(env.WHATSAPP_TEST_RECIPIENT);
	try {
		const result = await fetch(`https://graph.facebook.com/v26.0/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
			method: "POST", headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`, "Content-Type": "application/json" },
			body: JSON.stringify({ messaging_product: "whatsapp", to: recipient, type: "template", template: { name: "hello_world", language: { code: "en_US" } } }),
		});
		const raw = await result.text();
		await logWhatsApp(env.DB, null, recipient, "API test", result.ok ? "sent" : "failed", "hello_world", raw, null, result.ok ? null : raw);
		return { sent: result.ok, response: raw };
	} catch (error) { return { sent: false, reason: error instanceof Error ? error.message : "WhatsApp test failed" }; }
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
		`SELECT id, order_code, customer_name, customer_phone, delivery_method, payment_reference, status, quote_status, whatsapp_consent,
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
	const order = await c.env.DB.prepare("SELECT id, status, order_code, customer_phone, whatsapp_consent, delivery_method, markup_rate, customs_rate, delivery_rate, deposit_rate FROM orders WHERE id = ?").bind(orderId).first<Record<string, unknown>>();
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
	const notification = await sendWhatsAppStatus(c.env, { id: orderId, order_code: String(order.order_code), customer_phone: String(order.customer_phone), whatsapp_consent: Number(order.whatsapp_consent) }, STATUS.quoteAcceptance);
	return c.json({ ok: true, status: STATUS.quoteAcceptance, totals, notification });
});

app.patch("/api/admin/orders/:id/status", async (c) => {
	const admin = await requireAdmin(c.req.raw, c.env);
	if (!admin) return jsonError("Sign in required.", 401);
	const body = await c.req.json<{ status?: string; note?: string; refundAmount?: number }>();
	const status = String(body.status || "");
	if (!VALID_STATUSES.includes(status as (typeof VALID_STATUSES)[number])) return jsonError("Invalid order status.");
	const orderId = Number(c.req.param("id"));
	const current = await c.env.DB.prepare("SELECT id, status, order_code, customer_phone, whatsapp_consent FROM orders WHERE id = ?").bind(orderId).first<{ id: number; status: string; order_code: string; customer_phone: string; whatsapp_consent: number }>();
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
	const notification = await sendWhatsAppStatus(c.env, current, status);
	return c.json({ ok: true, status, notification });
});


async function sendWhatsAppText(env: Bindings, recipient: string, text: string, orderId: number | null = null) {
	if (!env.WHATSAPP_ACCESS_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) return { sent: false, reason: "WhatsApp API is not configured." };
	const target = env.WHATSAPP_MODE === "test" ? normalizeWhatsAppNumber(env.WHATSAPP_TEST_RECIPIENT || "") : normalizeWhatsAppNumber(recipient);
	if (!target) return { sent: false, reason: "No WhatsApp recipient." };
	try {
		const response = await fetch(`https://graph.facebook.com/v26.0/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
			method: "POST",
			headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`, "Content-Type": "application/json" },
			body: JSON.stringify({ messaging_product: "whatsapp", to: target, type: "text", text: { preview_url: false, body: text } }),
		});
		const raw = await response.text();
		let messageId: string | null = null;
		try { messageId = JSON.parse(raw)?.messages?.[0]?.id || null; } catch { /* stored below */ }
		await logWhatsApp(env.DB, orderId, target, "WhatsApp assistant", response.ok ? "sent" : "failed", "freeform_text", raw, messageId, response.ok ? null : raw);
		return { sent: response.ok, response: raw };
	} catch (error) {
		const reason = error instanceof Error ? error.message : "WhatsApp text request failed";
		await logWhatsApp(env.DB, orderId, target, "WhatsApp assistant", "failed", "freeform_text", "", null, reason);
		return { sent: false, reason };
	}
}

type WhatsAppDraft = {
	name?: string;
	items?: Array<{ link?: string; name?: string; unitPrice?: number; quantity?: number; notes?: string; mediaId?: string }>;
	current?: { link?: string; name?: string; unitPrice?: number; quantity?: number; notes?: string; mediaId?: string };
	deliveryMethod?: "collection" | "delivery";
	deliveryAddress?: string;
};

function safeDraft(value: string | null | undefined): WhatsAppDraft {
	try { return value ? JSON.parse(value) as WhatsAppDraft : { items: [] }; } catch { return { items: [] }; }
}

async function getConversation(db: D1Database, phone: string) {
	return db.prepare("SELECT customer_phone, state, draft_json, last_order_code, marketing_opted_in FROM whatsapp_conversations WHERE customer_phone = ?").bind(phone).first<{ customer_phone: string; state: string; draft_json: string | null; last_order_code: string | null; marketing_opted_in: number }>();
}

async function saveConversation(db: D1Database, phone: string, state: string, draft: WhatsAppDraft, lastOrderCode?: string | null, marketingOptedIn?: boolean) {
	// The column is NOT NULL. Preserve its existing value when the caller does not change consent.
	const existing = await getConversation(db, phone);
	const effectiveConsent = marketingOptedIn === undefined ? (existing?.marketing_opted_in || 0) : (marketingOptedIn ? 1 : 0);
	await db.prepare(`INSERT INTO whatsapp_conversations (customer_phone, state, draft_json, last_order_code, marketing_opted_in, updated_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(customer_phone) DO UPDATE SET state = excluded.state, draft_json = excluded.draft_json, last_order_code = COALESCE(excluded.last_order_code, whatsapp_conversations.last_order_code), marketing_opted_in = excluded.marketing_opted_in, updated_at = excluded.updated_at`)
		.bind(phone, state, JSON.stringify(draft), lastOrderCode || null, effectiveConsent, new Date().toISOString()).run();
}

function assistantMenu() {
	return `Welcome to LELE RunnerZW 👋\n\nReply with a number:\n1. Place a new SHEIN order\n2. Track my order\n3. Send a product photo\n4. Speak to support\n5. Stop promotional messages\n\nYou can type CANCEL at any time to restart.`;
}

async function createOrderFromWhatsApp(env: Bindings, phone: string, draft: WhatsAppDraft) {
	const items = draft.items || [];
	if (!draft.name || !items.length || !draft.deliveryMethod) throw new Error("Order details are incomplete.");
	const pricing = await getPricing(env.DB);
	const payloadItems: ItemInput[] = items.map((item) => ({
		link: item.link || "", name: item.name || (item.mediaId ? "Product photo received in WhatsApp" : ""),
		unitPrice: numberValue(item.unitPrice), quantity: numberValue(item.quantity), notes: `${item.notes || ""}${item.mediaId ? `${item.notes ? " | " : ""}WhatsApp media ID: ${item.mediaId}` : ""}`,
	}));
	const totals = quote(payloadItems, pricing, draft.deliveryMethod);
	const now = new Date().toISOString();
	const trackingToken = randomToken();
	let code = orderCode();
	for (let attempt = 0; attempt < 4; attempt++) { const exists = await env.DB.prepare("SELECT id FROM orders WHERE order_code = ?").bind(code).first(); if (!exists) break; code = orderCode(); }
	const result = await env.DB.prepare(`INSERT INTO orders (
		order_code, tracking_token, customer_name, customer_phone, delivery_method, delivery_address, payment_reference, status, quote_status, customer_consent, whatsapp_consent,
		subtotal, markup_amount, customs_amount, delivery_amount, total_amount, deposit_amount, balance_amount, markup_rate, customs_rate, delivery_rate, deposit_rate, created_at, updated_at
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
		.bind(code, trackingToken, draft.name, phone, draft.deliveryMethod, draft.deliveryAddress || null, "", STATUS.priceReview, "pending", 1, 1, totals.subtotal, totals.markup, totals.customs, totals.delivery, totals.total, totals.deposit, totals.balance, pricing.markupRate, pricing.customsRate, pricing.deliveryRate, pricing.depositRate, now, now).run();
	const orderId = Number(result.meta.last_row_id);
	await env.DB.batch(payloadItems.map((item) => env.DB.prepare("INSERT INTO order_items (order_id, product_link, product_name, unit_price, quantity, notes) VALUES (?, ?, ?, ?, ?, ?)").bind(orderId, item.link || null, item.name || null, item.unitPrice, item.quantity, item.notes || null)));
	await addEvent(env.DB, orderId, STATUS.priceReview, "Customer submitted order through WhatsApp");
	for (let i = 0; i < items.length; i++) if (items[i].mediaId) await env.DB.prepare("INSERT INTO whatsapp_product_media (order_id, item_position, media_id, created_at) VALUES (?, ?, ?, ?)").bind(orderId, i + 1, items[i].mediaId, now).run();
	return { code, trackingToken, totals, orderId };
}

async function processWhatsAppMessage(env: Bindings, message: Record<string, unknown>) {
	const phone = normalizeWhatsAppNumber(String(message.from || ""));
	if (!phone) return;
	const type = String(message.type || "text");
	const text = type === "text" ? String((message.text as Record<string, unknown> | undefined)?.body || "").trim() : "";
	const imageId = type === "image" ? String((message.image as Record<string, unknown> | undefined)?.id || "") : "";
	const messageId = String(message.id || "");
	const seen = messageId ? await env.DB.prepare("SELECT id FROM whatsapp_inbound_messages WHERE meta_message_id = ?").bind(messageId).first() : null;
	if (seen) return;
	await env.DB.prepare("INSERT INTO whatsapp_inbound_messages (meta_message_id, customer_phone, message_type, message_text, media_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(messageId || null, phone, type, text || null, imageId || null, JSON.stringify(message), new Date().toISOString()).run();
	const conversation = await getConversation(env.DB, phone);
	let state = conversation?.state || "menu";
	let draft = safeDraft(conversation?.draft_json);
	if (!draft.items) draft.items = [];
	const upper = text.toUpperCase();
	if (upper === "CANCEL" || upper === "MENU" || upper === "START") { await saveConversation(env.DB, phone, "menu", { items: [] }); await sendWhatsAppText(env, phone, assistantMenu()); return; }
	if (upper === "STOP") { await saveConversation(env.DB, phone, "menu", { items: [] }, null, false); await sendWhatsAppText(env, phone, "You have been opted out of promotional messages. You can still receive essential order updates for orders you place."); return; }
	if (state === "menu") {
		if (upper === "1" || upper.includes("ORDER")) { await saveConversation(env.DB, phone, "await_name", { items: [] }); await sendWhatsAppText(env, phone, "Great. Please type your full name."); return; }
		if (upper === "2" || upper.includes("TRACK")) { await saveConversation(env.DB, phone, "await_tracking", draft); await sendWhatsAppText(env, phone, "Please type your LELE Runner order code, for example LR-123456-ZW."); return; }
		if (upper === "3" || upper.includes("PHOTO")) { await saveConversation(env.DB, phone, "await_product", { items: [] }); await sendWhatsAppText(env, phone, "Send a product photo now, or type a SHEIN product link/product name. Then I will ask for the displayed price and quantity."); return; }
		if (upper === "4" || upper.includes("SUPPORT")) { await sendWhatsAppText(env, phone, "A LELE Runner team member will assist you. Please type your question and include an order code if you have one."); await saveConversation(env.DB, phone, "support", draft); return; }
		await sendWhatsAppText(env, phone, assistantMenu()); return;
	}
	if (state === "await_name") { draft.name = text; await saveConversation(env.DB, phone, "await_product", draft); await sendWhatsAppText(env, phone, "Thank you. Send the first SHEIN link, type the product name, or send a clear product photo."); return; }
	if (state === "await_product") {
		if (imageId) { draft.current = { name: "Product photo received in WhatsApp", mediaId: imageId }; await saveConversation(env.DB, phone, "await_price", draft); await sendWhatsAppText(env, phone, "Photo received. What is the displayed SHEIN price in USD? Reply with numbers only, for example 12.50."); return; }
		if (!text) { await sendWhatsAppText(env, phone, "Please send a product link, product name or photo."); return; }
		draft.current = text.startsWith("http") ? { link: text } : { name: text };
		await saveConversation(env.DB, phone, "await_price", draft); await sendWhatsAppText(env, phone, "What is the displayed SHEIN price in USD? Reply with numbers only, for example 12.50."); return;
	}
	if (state === "await_price") { const price = Number(text.replace(/[^0-9.]/g, "")); if (!price || price <= 0) { await sendWhatsAppText(env, phone, "Please reply with a valid price, for example 12.50."); return; } draft.current = { ...draft.current, unitPrice: price }; await saveConversation(env.DB, phone, "await_quantity", draft); await sendWhatsAppText(env, phone, "How many units do you need? Reply with a whole number."); return; }
	if (state === "await_quantity") { const quantity = Number(text); if (!Number.isInteger(quantity) || quantity < 1) { await sendWhatsAppText(env, phone, "Please reply with a whole quantity, for example 1 or 2."); return; } draft.current = { ...draft.current, quantity }; await saveConversation(env.DB, phone, "await_notes", draft); await sendWhatsAppText(env, phone, "Reply with size, colour or other notes. Type NONE if there are no special notes."); return; }
	if (state === "await_notes") { draft.current = { ...draft.current, notes: upper === "NONE" ? "" : text }; draft.items.push(draft.current || {}); draft.current = undefined; await saveConversation(env.DB, phone, "await_another", draft); const count = draft.items.length; await sendWhatsAppText(env, phone, count >= 10 ? "You have reached the 10-product limit. Reply DONE to choose delivery." : `Product ${count} saved. Reply ADD to add another product, or DONE to choose delivery.`); return; }
	if (state === "await_another") { if (upper === "ADD" && (draft.items?.length || 0) < 10) { await saveConversation(env.DB, phone, "await_product", draft); await sendWhatsAppText(env, phone, "Send the next product link, product name or photo."); return; } if (upper === "DONE") { await saveConversation(env.DB, phone, "await_delivery", draft); await sendWhatsAppText(env, phone, "How should you receive your parcel? Reply 1 for collection or 2 for delivery to your address."); return; } await sendWhatsAppText(env, phone, "Reply ADD for another product or DONE to continue."); return; }
	if (state === "await_delivery") { if (text === "1") { draft.deliveryMethod = "collection"; await saveConversation(env.DB, phone, "await_consent", draft); await sendWhatsAppText(env, phone, "Reply YES to accept LELE Runner order terms and receive WhatsApp order updates. Reply CANCEL to stop."); return; } if (text === "2") { draft.deliveryMethod = "delivery"; await saveConversation(env.DB, phone, "await_address", draft); await sendWhatsAppText(env, phone, "Please type your delivery address, town and a nearby landmark."); return; } await sendWhatsAppText(env, phone, "Reply 1 for collection or 2 for delivery."); return; }
	if (state === "await_address") { draft.deliveryAddress = text; await saveConversation(env.DB, phone, "await_consent", draft); await sendWhatsAppText(env, phone, "Reply YES to accept LELE Runner order terms and receive WhatsApp order updates. Reply CANCEL to stop."); return; }
	if (state === "await_consent") { if (upper !== "YES") { await sendWhatsAppText(env, phone, "Your order was not submitted. Reply START whenever you are ready to begin again."); await saveConversation(env.DB, phone, "menu", { items: [] }); return; } try { const created = await createOrderFromWhatsApp(env, phone, draft); await saveConversation(env.DB, phone, "menu", { items: [] }, created.code, conversation?.marketing_opted_in === 1); await sendWhatsAppText(env, phone, `Order request received ✅\n\nOrder code: ${created.code}\nInitial estimate: $${created.totals.total.toFixed(2)}\n\nLELE Runner will verify the live SHEIN price and send your final quote before any deposit is required.\n\nTrack privately: https://lelerunner.lelerunnerzw.workers.dev/track/${created.code}?token=${created.trackingToken}`, created.orderId); } catch { await sendWhatsAppText(env, phone, "We could not submit the order. Please reply START and try again, or contact support."); } return; }
	if (state === "await_tracking") { const order = await env.DB.prepare("SELECT order_code, status, total_amount, deposit_amount, balance_amount FROM orders WHERE order_code = ? AND customer_phone = ?").bind(text.toUpperCase(), phone).first<{ order_code: string; status: string; total_amount: number; deposit_amount: number; balance_amount: number }>(); if (!order) { await sendWhatsAppText(env, phone, "Order not found for this WhatsApp number. Check the code and try again."); return; } await sendWhatsAppText(env, phone, `Order ${order.order_code}\nStatus: ${order.status}\nTotal: $${Number(order.total_amount).toFixed(2)}\nDeposit: $${Number(order.deposit_amount).toFixed(2)}\nBalance: $${Number(order.balance_amount).toFixed(2)}`); await saveConversation(env.DB, phone, "menu", { items: [] }); return; }
	if (state === "support") { await env.DB.prepare("INSERT INTO whatsapp_support_requests (customer_phone, message, created_at) VALUES (?, ?, ?)").bind(phone, text || "Photo/message received", new Date().toISOString()).run(); await sendWhatsAppText(env, phone, "Thank you. Your support request has been recorded. A LELE Runner team member will respond."); await saveConversation(env.DB, phone, "menu", draft); return; }
	await saveConversation(env.DB, phone, "menu", { items: [] }); await sendWhatsAppText(env, phone, assistantMenu());
}

app.get("/api/whatsapp/webhook", (c) => {
	const mode = c.req.query("hub.mode");
	const token = c.req.query("hub.verify_token");
	const challenge = c.req.query("hub.challenge");
	if (mode === "subscribe" && token && token === c.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) return c.text(challenge || "");
	return c.text("Forbidden", 403);
});

app.post("/api/whatsapp/webhook", async (c) => {
	let payload: Record<string, unknown>;
	try { payload = await c.req.json(); } catch { return c.text("Bad request", 400); }
	const entries = Array.isArray(payload.entry) ? payload.entry as Array<Record<string, unknown>> : [];
	for (const entry of entries) {
		const changes = Array.isArray(entry.changes) ? entry.changes as Array<Record<string, unknown>> : [];
		for (const change of changes) {
			const value = change.value as Record<string, unknown> | undefined;
			const messages = Array.isArray(value?.messages) ? value?.messages as Array<Record<string, unknown>> : [];
			for (const message of messages) await processWhatsAppMessage(c.env, message);
		}
	}
	return c.text("EVENT_RECEIVED", 200);
});

app.post("/api/admin/whatsapp/test", async (c) => {
	if (!(await requireAdmin(c.req.raw, c.env))) return jsonError("Sign in required.", 401);
	const result = await sendWhatsAppTest(c.env);
	if (!result.sent) return jsonError(result.reason || "WhatsApp test could not be sent.", 502);
	return c.json({ ok: true, message: "WhatsApp test message sent." });
});

export default app;
