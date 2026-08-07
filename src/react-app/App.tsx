import { FormEvent, useEffect, useMemo, useState } from "react";
import "./App.css";

type Pricing = { markupRate: number; customsRate: number; deliveryRate: number; depositRate: number };
type Item = { link: string; name: string; unitPrice: string; quantity: string; notes: string };
type Quote = { subtotal: number; markup: number; customs: number; delivery: number; total: number; deposit: number; balance: number };
type Receipt = { orderCode: string; trackingToken: string; status: string; totals: Quote };
type AdminOrder = {
	id: number;
	order_code: string;
	customer_name: string;
	customer_phone: string;
	delivery_method: string;
	payment_reference: string;
	status: string;
	total_amount: number;
	deposit_amount: number;
	balance_amount: number;
	created_at: string;
	items: Array<{ product_link: string | null; product_name: string | null; unit_price: number; quantity: number; notes: string | null }>;
};

const DEFAULT_PRICING: Pricing = { markupRate: 6, customsRate: 10, deliveryRate: 30, depositRate: 40 };
const MAX_PRODUCTS = 10;
const BUSINESS_WHATSAPP = "263775123428";
const STATUSES = ["Awaiting deposit verification", "Placed", "Purchased", "Shipped", "Customs", "Delivered"];
const blankItem = (): Item => ({ link: "", name: "", unitPrice: "", quantity: "1", notes: "" });

const money = (value: number) => `$${Number(value || 0).toFixed(2)}`;

async function request<T>(url: string, options?: RequestInit): Promise<T> {
	const response = await fetch(url, {
		credentials: "same-origin",
		headers: { "content-type": "application/json", ...(options?.headers || {}) },
		...options,
	});
	const payload = (await response.json()) as T & { error?: string };
	if (!response.ok) throw new Error(payload.error || "Something went wrong.");
	return payload;
}

function calculate(items: Item[], pricing: Pricing, deliveryMethod: "collection" | "delivery"): Quote {
	const subtotal = items.reduce((sum, item) => sum + (Number(item.unitPrice) || 0) * (Number(item.quantity) || 0), 0);
	const markup = subtotal * (pricing.markupRate / 100);
	const customs = subtotal * (pricing.customsRate / 100);
	const beforeDelivery = subtotal + markup + customs;
	const delivery = deliveryMethod === "delivery" ? beforeDelivery * (pricing.deliveryRate / 100) : 0;
	const total = beforeDelivery + delivery;
	return { subtotal, markup, customs, delivery, total, deposit: total * (pricing.depositRate / 100), balance: total * (1 - pricing.depositRate / 100) };
}

function SprintLogo() {
	return <svg className="sprint-logo" viewBox="0 0 48 36" aria-hidden="true"><path d="M17 5.3c0-2 1.6-3.6 3.6-3.6s3.6 1.6 3.6 3.6-1.6 3.6-3.6 3.6S17 7.3 17 5.3Zm3.4 5.8 5.2 4.4 9.7-1.1c1.4-.2 2.7.8 2.8 2.2.1 1.4-.8 2.6-2.1 2.8L24.6 21c-.9.1-1.8-.1-2.5-.7l-4.8-4-3.9 7.3 7.1 4.1c1.2.7 1.6 2.2.9 3.4-.7 1.2-2.2 1.6-3.4.9L8.2 26.4c-1.2-.7-1.7-2.2-1-3.5l6.3-11.7c1.3-2.4 4.8-2 6.9-.1Z" /><path d="M27.5 21.5c1.1-.9 2.7-.7 3.6.4l5.2 6.5 7 .7c1.4.1 2.4 1.3 2.3 2.7-.1 1.3-1.2 2.3-2.5 2.3h-.2l-8.1-.9c-.7-.1-1.3-.4-1.8-.9l-5.9-7.3c-.9-1.1-.7-2.7.4-3.6Z" /></svg>;
}

function Header({ view, setView }: { view: "customer" | "admin"; setView: (view: "customer" | "admin") => void }) {
	return <>
		<header className="topbar"><div className="nav"><button className="brand" onClick={() => setView("customer")}><SprintLogo /><span>LELE RUNNER</span></button><div className="nav-actions"><a className="business-link" href={`https://wa.me/${BUSINESS_WHATSAPP}`} target="_blank" rel="noreferrer">WhatsApp +263 775 123 428</a><button className="admin-link" onClick={() => setView(view === "admin" ? "customer" : "admin")}>{view === "admin" ? "Customer page" : "Admin sign in"}</button></div></div></header>
		<div className="airmail" />
	</>;
}

function CustomerPage() {
	const [pricing, setPricing] = useState<Pricing>(DEFAULT_PRICING);
	const [items, setItems] = useState<Item[]>([blankItem()]);
	const [name, setName] = useState("");
	const [phone, setPhone] = useState("");
	const [delivery, setDelivery] = useState<"collection" | "delivery">("collection");
	const [address, setAddress] = useState("");
	const [reference, setReference] = useState("");
	const [receipt, setReceipt] = useState<Receipt | null>(null);
	const [error, setError] = useState("");
	const [saving, setSaving] = useState(false);

	useEffect(() => { request<Pricing>("/api/pricing").then(setPricing).catch(() => setPricing(DEFAULT_PRICING)); }, []);
	const totals = useMemo(() => calculate(items, pricing, delivery), [items, pricing, delivery]);
	const updateItem = (index: number, field: keyof Item, value: string) => setItems((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, [field]: value } : item));

	async function submit(event: FormEvent) {
		event.preventDefault();
		setError("");
		if (!name.trim() || !phone.trim()) return setError("Enter your name and WhatsApp number.");
		if (delivery === "delivery" && !address.trim()) return setError("Enter your delivery address.");
		if (reference.trim().length < 4) return setError("Enter your deposit payment reference.");
		if (items.some((item) => (!item.link.trim() && !item.name.trim()) || Number(item.unitPrice) <= 0 || Number(item.quantity) < 1)) return setError("Every product needs a link or name, price and quantity.");
		setSaving(true);
		try {
			const result = await request<Receipt>("/api/orders", { method: "POST", body: JSON.stringify({ customerName: name, customerPhone: phone, deliveryMethod: delivery, deliveryAddress: address, paymentReference: reference, items }) });
			setReceipt(result);
		} catch (submitError) { setError(submitError instanceof Error ? submitError.message : "Could not submit the order."); }
		finally { setSaving(false); }
	}

	if (receipt) {
		const message = `Hi LELE Runner, I have submitted order ${receipt.orderCode}. Required deposit: ${money(receipt.totals.deposit)}. Payment reference: ${reference}.`;
		return <main className="customer-page"><section className="receipt card"><p className="eyebrow">Order received</p><h1>Your order is in the system.</h1><p>Keep this tracking code and private tracking link. Our team will verify your deposit before placing the order.</p><div className="tracking-code">{receipt.orderCode}</div><div className="deposit-panel"><span>Required deposit</span><strong>{money(receipt.totals.deposit)}</strong><small>40% of your quoted total</small></div><a className="button whatsapp-button" target="_blank" rel="noreferrer" href={`https://wa.me/${BUSINESS_WHATSAPP}?text=${encodeURIComponent(message)}`}>Send order confirmation on WhatsApp</a><p className="tracking-link">Private tracking link:<br /><a href={`/track/${receipt.orderCode}?token=${receipt.trackingToken}`}>{`${window.location.origin}/track/${receipt.orderCode}?token=${receipt.trackingToken}`}</a></p><button className="text-button" onClick={() => { setReceipt(null); setItems([blankItem()]); setReference(""); }}>Start another order</button></section></main>;
	}

	return <main className="customer-page"><section className="hero"><p className="eyebrow">SHEIN orders · up to 10 products</p><h1>One clear order for your SHEIN products.</h1><p>Add your products, review the deposit, and submit one order that can be tracked by you and our team.</p></section><form className="card order-card" onSubmit={submit}><h2>Start your order</h2><div className="two-col"><label><span>Your name</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="T. Moyo" /></label><label><span>WhatsApp number</span><input value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="077..." inputMode="tel" /></label></div><div className="section-heading"><strong>Your SHEIN products</strong><span>{items.length} / {MAX_PRODUCTS}</span></div>{items.map((item, index) => <div className="item" key={index}><div className="item-title"><strong>Product {index + 1}</strong>{items.length > 1 && <button type="button" className="remove" onClick={() => setItems((current) => current.filter((_, itemIndex) => itemIndex !== index))}>Remove</button>}</div><label><span>SHEIN product link</span><input value={item.link} onChange={(event) => updateItem(index, "link", event.target.value)} placeholder="Paste the product link" /></label><label><span>Product name, if no link</span><input value={item.name} onChange={(event) => updateItem(index, "name", event.target.value)} placeholder="Describe the product" /></label><div className="two-col"><label><span>Item price (USD)</span><input type="number" min="0.01" step="0.01" value={item.unitPrice} onChange={(event) => updateItem(index, "unitPrice", event.target.value)} placeholder="0.00" /></label><label><span>Quantity</span><input type="number" min="1" step="1" value={item.quantity} onChange={(event) => updateItem(index, "quantity", event.target.value)} /></label></div><label><span>Size, colour or notes</span><textarea value={item.notes} onChange={(event) => updateItem(index, "notes", event.target.value)} placeholder="Size M, black, or other important detail" /></label></div>)}{items.length < MAX_PRODUCTS && <button type="button" className="add-product" onClick={() => setItems((current) => [...current, blankItem()])}>+ Add another product</button>}<div className="section-heading"><strong>Delivery choice</strong></div><div className="choices"><label className={delivery === "collection" ? "selected" : ""}><input type="radio" checked={delivery === "collection"} onChange={() => setDelivery("collection")} />I will collect my parcel <small>No delivery charge</small></label><label className={delivery === "delivery" ? "selected" : ""}><input type="radio" checked={delivery === "delivery"} onChange={() => setDelivery("delivery")} />Deliver to my address <small>Delivery is {pricing.deliveryRate}% of the order amount</small></label></div>{delivery === "delivery" && <label><span>Delivery address</span><textarea value={address} onChange={(event) => setAddress(event.target.value)} placeholder="House number, suburb, town and a landmark" /></label>}<div className="quote"><div><span>Product subtotal</span><b>{money(totals.subtotal)}</b></div><div><span>Service markup ({pricing.markupRate}%)</span><b>{money(totals.markup)}</b></div><div><span>Customs & logistics ({pricing.customsRate}%)</span><b>{money(totals.customs)}</b></div>{delivery === "delivery" && <div><span>Delivery</span><b>{money(totals.delivery)}</b></div>}<div className="quote-total"><span>Total estimate</span><b>{money(totals.total)}</b></div></div><div className="deposit-panel"><span>Required deposit ({pricing.depositRate}%)</span><strong>{money(totals.deposit)}</strong><small>Balance after deposit: {money(totals.balance)}</small></div><label><span>Deposit payment reference</span><input value={reference} onChange={(event) => setReference(event.target.value)} placeholder="Example: MP240805.1234" /></label><p className="notice">Do not enter a mobile-money PIN, banking password or OTP. Enter only a normal payment reference.</p>{error && <p className="error">{error}</p>}<button className="button" disabled={saving}>{saving ? "Submitting order..." : "Submit order for verification"}</button></form></main>;
}

function AdminPage() {
	const [mode, setMode] = useState<"login" | "setup" | "dashboard">("login");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [setupToken, setSetupToken] = useState("");
	const [orders, setOrders] = useState<AdminOrder[]>([]);
	const [pricing, setPricing] = useState<Pricing>(DEFAULT_PRICING);
	const [error, setError] = useState("");
	const [message, setMessage] = useState("");

	async function loadDashboard() {
		const [orderData, pricingData] = await Promise.all([request<{ orders: AdminOrder[] }>("/api/admin/orders"), request<Pricing>("/api/admin/pricing")]);
		setOrders(orderData.orders); setPricing(pricingData); setMode("dashboard");
	}
	async function login(event: FormEvent) { event.preventDefault(); setError(""); try { await request("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }); await loadDashboard(); } catch (loginError) { setError(loginError instanceof Error ? loginError.message : "Could not sign in."); } }
	async function setup(event: FormEvent) { event.preventDefault(); setError(""); try { await request("/api/auth/bootstrap", { method: "POST", body: JSON.stringify({ email, password, setupToken }) }); await loadDashboard(); } catch (setupError) { setError(setupError instanceof Error ? setupError.message : "Could not create the account."); } }
	async function savePricing(event: FormEvent) { event.preventDefault(); setMessage(""); try { const next = await request<Pricing>("/api/admin/pricing", { method: "PUT", body: JSON.stringify(pricing) }); setPricing(next); setMessage("Pricing saved. New orders will use these percentages."); } catch (saveError) { setError(saveError instanceof Error ? saveError.message : "Could not save pricing."); } }
	async function updateStatus(id: number, status: string) { try { await request(`/api/admin/orders/${id}/status`, { method: "PATCH", body: JSON.stringify({ status }) }); await loadDashboard(); } catch (statusError) { setError(statusError instanceof Error ? statusError.message : "Could not update status."); } }

	if (mode !== "dashboard") return <main className="admin-page"><section className="auth-card card"><p className="eyebrow">Secure admin area</p><h1>{mode === "setup" ? "Create the first administrator" : "Admin sign in"}</h1><p className="muted">This live application uses a server-side account. No PIN is included in the customer website.</p><form onSubmit={mode === "setup" ? setup : login}><label><span>Email address</span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label><label><span>Password</span><input type="password" minLength={12} value={password} onChange={(event) => setPassword(event.target.value)} required /></label>{mode === "setup" && <label><span>Private setup token</span><input type="password" value={setupToken} onChange={(event) => setSetupToken(event.target.value)} required /><small>This is the Cloudflare secret called SETUP_TOKEN. It is never shown to customers.</small></label>}{error && <p className="error">{error}</p>}<button className="button">{mode === "setup" ? "Create secure admin account" : "Sign in"}</button></form><button className="text-button" onClick={() => { setError(""); setMode(mode === "setup" ? "login" : "setup"); }}>{mode === "setup" ? "I already have an admin account" : "First administrator setup"}</button></section></main>;

	return <main className="admin-page"><section className="admin-header"><div><p className="eyebrow">Shared database dashboard</p><h1>LELE Runner orders</h1></div><button className="admin-link" onClick={() => { request("/api/auth/logout", { method: "POST" }); setMode("login"); }}>Sign out</button></section><section className="stats"><article><span>Awaiting deposit</span><b>{orders.filter((order) => order.status === "Awaiting deposit verification").length}</b></article><article><span>In progress</span><b>{orders.filter((order) => !["Awaiting deposit verification", "Delivered"].includes(order.status)).length}</b></article><article><span>Orders total</span><b>{money(orders.reduce((sum, order) => sum + Number(order.total_amount), 0))}</b></article></section><section className="admin-grid"><form className="card pricing-card" onSubmit={savePricing}><h2>Pricing settings</h2><p className="muted">Only new orders use updated rates. Existing quotes stay unchanged.</p>{([['markupRate','Service markup'], ['customsRate','Customs & logistics'], ['deliveryRate','Delivery'], ['depositRate','Deposit']] as Array<[keyof Pricing, string]>).map(([key, label]) => <label key={key}><span>{label} (%)</span><input type="number" min="0" step="0.1" value={pricing[key]} onChange={(event) => setPricing({ ...pricing, [key]: Number(event.target.value) })} /></label>)}<button className="button">Save percentages</button>{message && <p className="success">{message}</p>}</form><section className="card orders-card"><h2>All orders</h2>{error && <p className="error">{error}</p>}{orders.length === 0 ? <p className="muted">No customer orders yet.</p> : orders.map((order) => <article className="order-row" key={order.id}><div className="order-top"><div><strong>{order.order_code}</strong><p>{order.customer_name} · {order.customer_phone}</p></div><select value={order.status} onChange={(event) => updateStatus(order.id, event.target.value)}>{STATUSES.map((status) => <option key={status}>{status}</option>)}</select></div><div className="order-meta"><span>{order.items.length} product{order.items.length === 1 ? "" : "s"}</span><span>Total {money(order.total_amount)}</span><span>Deposit {money(order.deposit_amount)}</span></div><ul>{order.items.map((item, index) => <li key={index}>{item.product_name || item.product_link || "SHEIN product"} · {money(item.unit_price)} × {item.quantity}</li>)}</ul><small>Payment reference: {order.payment_reference} · {order.delivery_method === "delivery" ? "Delivery" : "Collection"}</small></article>)}</section></section></main>;
}

export default function App() {
	const [view, setView] = useState<"customer" | "admin">("customer");
	return <><Header view={view} setView={setView} />{view === "customer" ? <CustomerPage /> : <AdminPage />}<footer>LELE Runner · SHEIN orders, tracking and customer updates</footer></>;
}
