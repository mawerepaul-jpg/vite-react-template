import { FormEvent, useEffect, useMemo, useState } from "react";
import beaverMascot from "./assets/lele-runner-beaver.png";
import "./App.css";

type Pricing = { markupRate: number; customsRate: number; deliveryRate: number; depositRate: number };
type Item = { id?: number; link: string; name: string; unitPrice: string; quantity: string; notes: string; photoName?: string };
type Quote = { subtotal: number; markup: number; customs: number; delivery: number; total: number; deposit: number; balance: number };
type Receipt = { orderCode: string; trackingToken: string; status: string; totals: Quote };
type EventLog = { status: string; note: string | null; actor_email?: string | null; created_at: string };
type AdminOrder = {
	id: number; order_code: string; customer_name: string; customer_phone: string; delivery_method: string;
	payment_reference: string; status: string; quote_status: string; total_amount: number; deposit_amount: number;
	balance_amount: number; final_quote_note: string | null; refund_amount: number; refund_status: string | null;
	created_at: string; updated_at: string; items: Item[]; events: EventLog[];
};
type TrackOrder = {
	id: number; order_code: string; status: string; quote_status: string; delivery_method: string;
	total_amount: number; deposit_amount: number; balance_amount: number; payment_reference: string;
	final_quote_note: string | null; updated_at: string; quote_accepted_at: string | null; items: Item[]; events: EventLog[];
};

const DEFAULT_PRICING: Pricing = { markupRate: 6, customsRate: 10, deliveryRate: 30, depositRate: 40 };
const MAX_PRODUCTS = 10;
const BUSINESS_WHATSAPP = "263773835075";
const BACKUP_WHATSAPP = "263775123428";
const STATUS = {
	priceReview: "Awaiting price verification", quoteAcceptance: "Awaiting customer quote acceptance", deposit: "Awaiting deposit",
	depositVerification: "Awaiting deposit verification", placed: "Placed", purchased: "Purchased", shipped: "Shipped",
	customs: "Customs", outForDelivery: "Out for delivery", delivered: "Delivered", cancelled: "Cancelled",
	refundPending: "Refund pending", refunded: "Refunded",
};
const blankItem = (): Item => ({ link: "", name: "", unitPrice: "", quantity: "1", notes: "", photoName: "" });
const money = (value: number | string) => `$${Number(value || 0).toFixed(2)}`;

async function request<T>(url: string, options?: RequestInit): Promise<T> {
	const response = await fetch(url, { credentials: "same-origin", headers: { "content-type": "application/json", ...(options?.headers || {}) }, ...options });
	const raw = await response.text();
	let payload: (T & { error?: string }) | undefined;
	try { payload = JSON.parse(raw) as T & { error?: string }; } catch { throw new Error(response.ok ? "The server returned an unexpected response." : raw || "The server could not complete the request."); }
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

function JourneySteps() {
	const steps = ["Your details", "Products", "Delivery & quote", "Submit & track"];
	return <ol className="journey" aria-label="Order steps">{steps.map((step, index) => <li key={step}><span>{index + 1}</span><strong>{step}</strong></li>)}</ol>;
}

function StatusPill({ status }: { status: string }) {
	return <span className={`status-pill ${status.toLowerCase().replace(/\s+/g, "-")}`}>{status}</span>;
}

function Header({ view, setView }: { view: "customer" | "admin"; setView: (view: "customer" | "admin") => void }) {
	function goHome() { if (window.location.pathname.startsWith("/track/")) window.location.assign("/"); else setView("customer"); }
	return <>
		<header className="topbar"><div className="nav"><button className="brand" onClick={goHome}><span className="mascot-frame"><img className="beaver-mascot" src={beaverMascot} alt="LELE RunnerZW beaver parcel mascot" /></span><span>LELE RUNNER</span></button><div className="nav-actions"><div className="business-lines"><a className="business-link" href={`https://wa.me/${BUSINESS_WHATSAPP}`} target="_blank" rel="noreferrer">Line 1: +263 773 835 075</a><a className="business-link" href={`https://wa.me/${BACKUP_WHATSAPP}`} target="_blank" rel="noreferrer">Line 2: +263 775 123 428</a></div><button className="admin-link" onClick={() => setView(view === "admin" ? "customer" : "admin")}>{view === "admin" ? "Customer page" : "Admin sign in"}</button></div></div></header>
		<div className="airmail" />
	</>;
}

function TermsSummary() {
	return <details className="policy-summary"><summary>Order terms and privacy notice</summary><div><p><strong>Price verification:</strong> The first estimate is based on the details you provide. LELE Runner verifies the live item price before requesting the deposit.</p><p><strong>Payment:</strong> Never enter a mobile-money PIN, banking password or OTP. A payment reference is supplied only after you accept the final quote.</p><p><strong>Privacy:</strong> Your name, WhatsApp number and delivery information are used only to process and communicate about your order.</p><p><strong>Changes and refunds:</strong> If an item is unavailable or the price changes, LELE Runner will contact you before purchase. Cancellation and refund decisions follow the business policy communicated with your quote.</p></div></details>;
}

function CustomerPage() {
	const [pricing, setPricing] = useState<Pricing>(DEFAULT_PRICING);
	const [items, setItems] = useState<Item[]>([blankItem()]);
	const [name, setName] = useState("");
	const [phone, setPhone] = useState("");
	const [delivery, setDelivery] = useState<"collection" | "delivery">("collection");
	const [address, setAddress] = useState("");
	const [consent, setConsent] = useState(false);
	const [whatsappConsent, setWhatsappConsent] = useState(false);
	const [receipt, setReceipt] = useState<Receipt | null>(null);
	const [error, setError] = useState("");
	const [saving, setSaving] = useState(false);
	useEffect(() => { request<Pricing>("/api/pricing").then(setPricing).catch(() => setPricing(DEFAULT_PRICING)); }, []);
	const totals = useMemo(() => calculate(items, pricing, delivery), [items, pricing, delivery]);
	const updateItem = (index: number, field: keyof Item, value: string) => setItems((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, [field]: value } : item));
	const selectPhoto = (index: number, file?: File) => updateItem(index, "photoName", file?.name || "");

	async function submit(event: FormEvent) {
		event.preventDefault(); setError("");
		if (!name.trim() || !phone.trim()) return setError("Enter your name and WhatsApp number.");
		if (delivery === "delivery" && !address.trim()) return setError("Enter your delivery address.");
		if (!consent) return setError("Please accept the order terms and privacy notice.");
		if (items.some((item) => (!item.link.trim() && !item.name.trim() && !item.photoName) || Number(item.unitPrice) <= 0 || Number(item.quantity) < 1)) return setError("Every product needs a SHEIN link, product name or selected photo, plus a price and quantity.");
		const orderItems = items.map((item) => ({ ...item, name: item.name.trim() || (item.photoName ? `Product photo to follow on WhatsApp: ${item.photoName}` : ""), notes: item.photoName ? `${item.notes || ""}${item.notes ? " | " : ""}Customer selected photo: ${item.photoName}` : item.notes }));
		setSaving(true);
		try {
			const result = await request<Receipt>("/api/orders", { method: "POST", body: JSON.stringify({ customerName: name, customerPhone: phone, deliveryMethod: delivery, deliveryAddress: address, customerConsent: consent, whatsappConsent, items: orderItems }) });
			setReceipt(result);
		} catch (submitError) { setError(submitError instanceof Error ? submitError.message : "Could not submit the order."); }
		finally { setSaving(false); }
	}

	if (receipt) { const photoCount = items.filter((item) => item.photoName).length; const whatsAppText = `Hi LELE Runner, I submitted order ${receipt.orderCode}. ${photoCount ? `I am attaching ${photoCount} product photo(s) now.` : "Please verify my SHEIN items and final quote."}`; return <main className="customer-page"><section className="receipt card"><p className="eyebrow">Order request received</p><h1>We will verify your item prices first.</h1><p>Your request is stored safely. A LELE Runner staff member will verify the live SHEIN price and issue your final quote before asking for a deposit.</p><div className="tracking-code">{receipt.orderCode}</div><div className="deposit-panel"><span>Initial estimate — no payment required yet</span><strong>{money(receipt.totals.deposit)}</strong><small>Expected 40% deposit after you accept the staff-verified final quote.</small></div>{photoCount > 0 && <div className="photo-whatsapp-note"><strong>Product photo selected</strong><p>WhatsApp will open next. Please tap the paperclip/attachment button in WhatsApp and attach your selected product photo before sending.</p></div>}<p className="tracking-link">Keep this private order-tracking link:<br /><a href={`/track/${receipt.orderCode}?token=${receipt.trackingToken}`}>{`${window.location.origin}/track/${receipt.orderCode}?token=${receipt.trackingToken}`}</a></p><a className="button whatsapp-button" target="_blank" rel="noreferrer" href={`https://wa.me/${BUSINESS_WHATSAPP}?text=${encodeURIComponent(whatsAppText)}`}>{photoCount ? "Open WhatsApp to attach product photo" : "Contact WhatsApp Line 1"}</a><button className="text-button" onClick={() => { setReceipt(null); setItems([blankItem()]); }}>Start another order</button></section></main>; }

	return <main className="customer-page"><section className="hero"><p className="eyebrow">SHEIN orders · up to 10 products</p><h1>One clear order for your SHEIN products.</h1><p>Submit a request, receive a staff-verified quote, then pay the deposit only after you accept the final amount.</p><a className="whatsapp-order-shortcut" target="_blank" rel="noreferrer" href={`https://wa.me/${BUSINESS_WHATSAPP}?text=${encodeURIComponent("Hi LELE Runner, I would like to place a SHEIN order through WhatsApp. I will send product links or pictures.")}`}>Prefer WhatsApp? Start an order on Line 1</a></section><JourneySteps /><form className="card order-card" onSubmit={submit}><div className="form-title"><div><p className="eyebrow">Step 1 · Order details</p><h2>Start your order</h2></div><span className="safe-order">Secure order form</span></div><p className="form-intro">Add the product link and details exactly as they appear on SHEIN. You can add up to 10 products in one request.</p><div className="two-col"><label><span>Your name</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="T. Moyo" /></label><label><span>WhatsApp number</span><input value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="077..." inputMode="tel" /></label></div><div className="section-heading"><strong>Your SHEIN products</strong><span>{items.length} / {MAX_PRODUCTS}</span></div>{items.map((item, index) => <div className="item" key={index}><div className="item-title"><strong>Product {index + 1}</strong>{items.length > 1 && <button type="button" className="remove" onClick={() => setItems((current) => current.filter((_, itemIndex) => itemIndex !== index))}>Remove</button>}</div><label><span>SHEIN product link</span><input value={item.link} onChange={(event) => updateItem(index, "link", event.target.value)} placeholder="Paste the product link" /></label><label className="photo-input"><span>Product photo, if no link</span><input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => selectPhoto(index, event.target.files?.[0])} /><small>{item.photoName ? `Selected: ${item.photoName}. After submitting, attach this photo in WhatsApp.` : "Choose a screenshot or product photo. The picture is not uploaded here; you will attach it in WhatsApp after submitting."}</small></label><label><span>Product name, if no link or photo</span><input value={item.name} onChange={(event) => updateItem(index, "name", event.target.value)} placeholder="Describe the product" /></label><div className="two-col"><label><span>Displayed item price (USD)</span><input type="number" min="0.01" step="0.01" value={item.unitPrice} onChange={(event) => updateItem(index, "unitPrice", event.target.value)} placeholder="0.00" /></label><label><span>Quantity</span><input type="number" min="1" step="1" value={item.quantity} onChange={(event) => updateItem(index, "quantity", event.target.value)} /></label></div><label><span>Size, colour or notes</span><textarea value={item.notes} onChange={(event) => updateItem(index, "notes", event.target.value)} placeholder="Size M, black, or other important detail" /></label></div>)}{items.length < MAX_PRODUCTS && <button type="button" className="add-product" onClick={() => setItems((current) => [...current, blankItem()])}>+ Add another product</button>}<div className="section-heading"><strong>Delivery choice</strong></div><div className="choices"><label className={delivery === "collection" ? "selected" : ""}><input type="radio" checked={delivery === "collection"} onChange={() => setDelivery("collection")} />I will collect my parcel <small>No delivery charge</small></label><label className={delivery === "delivery" ? "selected" : ""}><input type="radio" checked={delivery === "delivery"} onChange={() => setDelivery("delivery")} />Deliver to my address <small>Delivery is {pricing.deliveryRate}% of the order amount</small></label></div>{delivery === "delivery" && <label><span>Delivery address</span><textarea value={address} onChange={(event) => setAddress(event.target.value)} placeholder="House number, suburb, town and a landmark" /></label>}<div className="quote"><div><span>Initial product subtotal</span><b>{money(totals.subtotal)}</b></div><div><span>Service markup ({pricing.markupRate}%)</span><b>{money(totals.markup)}</b></div><div><span>Customs & logistics ({pricing.customsRate}%)</span><b>{money(totals.customs)}</b></div>{delivery === "delivery" && <div><span>Delivery</span><b>{money(totals.delivery)}</b></div>}<div className="quote-total"><span>Initial estimate</span><b>{money(totals.total)}</b></div></div><div className="deposit-panel"><span>Expected deposit after staff verifies final quote</span><strong>{money(totals.deposit)}</strong><small>The final amount may change only if the live SHEIN price, availability or selected option changes.</small></div><TermsSummary /><label className="consent"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} /><span>I accept the order terms and privacy notice.</span></label><label className="consent"><input type="checkbox" checked={whatsappConsent} onChange={(event) => setWhatsappConsent(event.target.checked)} /><span>I agree to receive WhatsApp order updates on the number above.</span></label>{error && <p className="error">{error}</p>}<button className="button" disabled={saving}>{saving ? "Submitting request..." : "Submit request for price verification"}</button></form></main>;
}

function TrackPage({ orderCode, token }: { orderCode: string; token: string }) {
	const [order, setOrder] = useState<TrackOrder | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [reference, setReference] = useState("");
	const [busy, setBusy] = useState(false);
	const load = async () => { try { setLoading(true); setOrder(await request<TrackOrder>(`/api/track/${encodeURIComponent(orderCode)}?token=${encodeURIComponent(token)}`)); } catch (trackError) { setError(trackError instanceof Error ? trackError.message : "Could not load this order."); } finally { setLoading(false); } };
	useEffect(() => { load(); }, [orderCode, token]);
	async function acceptQuote() { setBusy(true); setError(""); try { await request(`/api/track/${orderCode}/accept-quote`, { method: "POST", body: JSON.stringify({ token }) }); await load(); } catch (acceptError) { setError(acceptError instanceof Error ? acceptError.message : "Could not accept quote."); } finally { setBusy(false); } }
	async function submitPayment(event: FormEvent) { event.preventDefault(); setBusy(true); setError(""); try { await request(`/api/track/${orderCode}/payment`, { method: "POST", body: JSON.stringify({ token, paymentReference: reference }) }); await load(); } catch (paymentError) { setError(paymentError instanceof Error ? paymentError.message : "Could not submit payment reference."); } finally { setBusy(false); } }
	if (loading) return <main className="customer-page"><section className="card track-card"><h1>Loading your order…</h1></section></main>;
	if (!order) return <main className="customer-page"><section className="card track-card"><h1>Order unavailable</h1><p>{error || "This private tracking link is invalid or has expired."}</p></section></main>;
	return <main className="customer-page"><section className="card track-card"><p className="eyebrow">Private order tracking</p><div className="track-heading"><div><h1>{order.order_code}</h1><p>Keep this page private. It contains your personal order status.</p></div><StatusPill status={order.status} /></div><div className="track-summary"><div><span>Final total</span><strong>{money(order.total_amount)}</strong></div><div><span>Required deposit</span><strong>{money(order.deposit_amount)}</strong></div><div><span>Balance</span><strong>{money(order.balance_amount)}</strong></div></div><section className="track-items"><h2>Your order</h2>{order.items.map((item, index) => <div key={item.id || index}><span>{item.name || item.link || `Product ${index + 1}`} × {item.quantity}</span><b>{money(item.unitPrice)}</b></div>)}</section>{order.final_quote_note && <section className="quote-note"><strong>Staff note</strong><p>{order.final_quote_note}</p></section>}{order.status === STATUS.quoteAcceptance && <section className="customer-action"><h2>Your final quote is ready</h2><p>Review the amount above. By accepting, you confirm that LELE Runner may request the displayed deposit.</p><button className="button" disabled={busy} onClick={acceptQuote}>Accept final quote</button></section>}{order.status === STATUS.deposit && <section className="customer-action"><h2>Pay the verified deposit</h2><p>After payment, enter only the normal payment reference below. Do not enter a PIN, password or OTP.</p><form onSubmit={submitPayment}><label><span>Deposit payment reference</span><input value={reference} onChange={(event) => setReference(event.target.value)} placeholder="Example: MP240805.1234" required /></label><button className="button" disabled={busy}>Submit payment reference</button></form></section>}{order.status === STATUS.depositVerification && <div className="admin-alert"><span>◉</span><div><strong>Payment reference received</strong><p>LELE Runner is checking your deposit. You will receive an update once it is verified.</p></div></div>}{error && <p className="error">{error}</p>}<details className="event-history"><summary>Order history</summary>{order.events.map((event, index) => <div key={index}><StatusPill status={event.status} /><span>{event.note || "Order update"}</span><small>{new Date(event.created_at).toLocaleString()}</small></div>)}</details></section></main>;
}

function transitionOptions(status: string) {
	if (status === STATUS.depositVerification) return [STATUS.placed, STATUS.cancelled, STATUS.refundPending];
	if (status === STATUS.placed) return [STATUS.purchased, STATUS.cancelled, STATUS.refundPending];
	if (status === STATUS.purchased) return [STATUS.shipped, STATUS.cancelled, STATUS.refundPending];
	if (status === STATUS.shipped) return [STATUS.customs, STATUS.refundPending];
	if (status === STATUS.customs) return [STATUS.outForDelivery, STATUS.refundPending];
	if (status === STATUS.outForDelivery) return [STATUS.delivered, STATUS.refundPending];
	if (status === STATUS.refundPending) return [STATUS.refunded];
	return [STATUS.cancelled];
}

function AdminPage() {
	const [mode, setMode] = useState<"login" | "setup" | "dashboard">("login");
	const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [setupToken, setSetupToken] = useState("");
	const [orders, setOrders] = useState<AdminOrder[]>([]); const [pricing, setPricing] = useState<Pricing>(DEFAULT_PRICING);
	const [error, setError] = useState(""); const [message, setMessage] = useState("");
	const [editingQuote, setEditingQuote] = useState<number | null>(null); const [quoteItems, setQuoteItems] = useState<Item[]>([]); const [quoteNote, setQuoteNote] = useState("");
	async function loadDashboard() { const [orderData, pricingData] = await Promise.all([request<{ orders: AdminOrder[] }>("/api/admin/orders"), request<Pricing>("/api/admin/pricing")]); setOrders(orderData.orders); setPricing(pricingData); setMode("dashboard"); }
	async function login(event: FormEvent) { event.preventDefault(); setError(""); try { await request("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }); await loadDashboard(); } catch (loginError) { setError(loginError instanceof Error ? loginError.message : "Could not sign in."); } }
	async function setup(event: FormEvent) { event.preventDefault(); setError(""); try { await request("/api/auth/bootstrap", { method: "POST", body: JSON.stringify({ email, password, setupToken }) }); await loadDashboard(); } catch (setupError) { setError(setupError instanceof Error ? setupError.message : "Could not create the account."); } }
	async function savePricing(event: FormEvent) { event.preventDefault(); setMessage(""); try { const next = await request<Pricing>("/api/admin/pricing", { method: "PUT", body: JSON.stringify(pricing) }); setPricing(next); setMessage("Pricing saved. New customer requests will use these percentages."); } catch (saveError) { setError(saveError instanceof Error ? saveError.message : "Could not save pricing."); } }
	function beginQuote(order: AdminOrder) { setEditingQuote(order.id); setQuoteItems(order.items.map((item) => ({ ...item, unitPrice: String(item.unitPrice), quantity: String(item.quantity), link: item.link || "", name: item.name || "", notes: item.notes || "" }))); setQuoteNote(order.final_quote_note || ""); }
	function updateQuoteItem(index: number, field: keyof Item, value: string) { setQuoteItems((items) => items.map((item, i) => i === index ? { ...item, [field]: value } : item)); }
	async function issueQuote(order: AdminOrder) { setError(""); try { await request(`/api/admin/orders/${order.id}/quote`, { method: "PUT", body: JSON.stringify({ items: quoteItems.map((item) => ({ ...item, unitPrice: Number(item.unitPrice), quantity: Number(item.quantity) })), finalQuoteNote: quoteNote }) }); setEditingQuote(null); await loadDashboard(); } catch (quoteError) { setError(quoteError instanceof Error ? quoteError.message : "Could not issue quote."); } }
	async function updateStatus(order: AdminOrder, status: string) { const note = window.prompt(`Optional note for ${status}:`, "") || ""; const amount = status === STATUS.refundPending || status === STATUS.refunded ? Number(window.prompt("Refund amount, if any:", "0") || 0) : 0; try { await request(`/api/admin/orders/${order.id}/status`, { method: "PATCH", body: JSON.stringify({ status, note, refundAmount: amount }) }); await loadDashboard(); } catch (statusError) { setError(statusError instanceof Error ? statusError.message : "Could not update status."); } }
	if (mode !== "dashboard") return <main className="admin-page"><section className="auth-card card"><p className="eyebrow">Secure admin area</p><h1>{mode === "setup" ? "Create the first administrator" : "Admin sign in"}</h1><p className="muted">This live application uses a server-side account. No PIN is included in the customer website.</p><form onSubmit={mode === "setup" ? setup : login}><label><span>Email address</span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label><label><span>Password</span><input type="password" minLength={12} value={password} onChange={(event) => setPassword(event.target.value)} required /></label>{mode === "setup" && <label><span>Private setup token</span><input type="password" value={setupToken} onChange={(event) => setSetupToken(event.target.value)} required /><small>This is the Cloudflare secret called SETUP_TOKEN. It is never shown to customers.</small></label>}{error && <p className="error">{error}</p>}<button className="button">{mode === "setup" ? "Create secure admin account" : "Sign in"}</button></form><button className="text-button" onClick={() => { setError(""); setMode(mode === "setup" ? "login" : "setup"); }}>{mode === "setup" ? "I already have an admin account" : "First administrator setup"}</button></section></main>;
	return <main className="admin-page"><section className="admin-header"><div><p className="eyebrow">Shared database dashboard</p><h1>LELE Runner orders</h1><p className="muted">Verify live prices before payment, issue final quotes, and keep a clear history of every order action.</p></div><button className="admin-link" onClick={() => { request("/api/auth/logout", { method: "POST" }); setMode("login"); }}>Sign out</button></section><section className="admin-alert"><span>◉</span><div><strong>WhatsApp automation pending Meta review</strong><p>Use the customer number on each order for manual status updates until the official WhatsApp Business integration is approved.</p></div></section><section className="stats"><article><span>Price verification</span><b>{orders.filter((order) => order.status === STATUS.priceReview).length}</b><small>New requests to review</small></article><article><span>Awaiting deposit</span><b>{orders.filter((order) => [STATUS.deposit, STATUS.depositVerification].includes(order.status)).length}</b><small>Payment action needed</small></article><article><span>Orders total</span><b>{money(orders.reduce((sum, order) => sum + Number(order.total_amount), 0))}</b><small>All submitted orders</small></article></section><section className="admin-grid"><form className="card pricing-card" onSubmit={savePricing}><h2>Pricing settings</h2><p className="muted">These rates apply to new requests. Existing verified quotes stay unchanged.</p>{([['markupRate','Service markup'], ['customsRate','Customs & logistics'], ['deliveryRate','Delivery'], ['depositRate','Deposit']] as Array<[keyof Pricing, string]>).map(([key, label]) => <label key={key}><span>{label} (%)</span><input type="number" min="0" step="0.1" value={pricing[key]} onChange={(event) => setPricing({ ...pricing, [key]: Number(event.target.value) })} /></label>)}<button className="button">Save percentages</button>{message && <p className="success">{message}</p>}</form><section className="card orders-card"><h2>All orders</h2>{error && <p className="error">{error}</p>}{orders.length === 0 ? <p className="muted">No customer orders yet.</p> : orders.map((order) => <article className="order-row" key={order.id}><div className="order-top"><div><div className="order-id-row"><strong>{order.order_code}</strong><StatusPill status={order.status} /></div><p>{order.customer_name} · {order.customer_phone}</p></div>{order.status !== STATUS.priceReview && <select aria-label={`Change status for ${order.order_code}`} defaultValue="" onChange={(event) => { if (event.target.value) updateStatus(order, event.target.value); }}><option value="" disabled>Update status</option>{transitionOptions(order.status).map((status) => <option key={status} value={status}>{status}</option>)}</select>}</div><div className="order-meta"><span>{order.items.length} product{order.items.length === 1 ? "" : "s"}</span><span>Total {money(order.total_amount)}</span><span>Deposit {money(order.deposit_amount)}</span></div>{order.status === STATUS.priceReview && <button className="small-action" onClick={() => beginQuote(order)}>Verify item prices and issue quote</button>}{editingQuote === order.id && <section className="quote-editor"><h3>Verify final quote</h3><p>Confirm live SHEIN prices before sending the quote to the customer.</p>{quoteItems.map((item, index) => <div className="quote-editor-row" key={item.id || index}><input value={item.name || item.link} onChange={(event) => updateQuoteItem(index, "name", event.target.value)} placeholder="Product name" /><input type="number" value={item.unitPrice} onChange={(event) => updateQuoteItem(index, "unitPrice", event.target.value)} placeholder="Price" /><input type="number" value={item.quantity} onChange={(event) => updateQuoteItem(index, "quantity", event.target.value)} placeholder="Qty" /></div>)}<textarea value={quoteNote} onChange={(event) => setQuoteNote(event.target.value)} placeholder="Optional note to the customer about availability, price or expected delivery" /><div className="editor-actions"><button className="small-action" onClick={() => issueQuote(order)}>Issue final quote</button><button className="text-button" onClick={() => setEditingQuote(null)}>Cancel</button></div></section>}<ul>{order.items.map((item, index) => <li key={item.id || index}>{item.name || item.link || "SHEIN product"} · {money(item.unitPrice)} × {item.quantity}</li>)}</ul>{order.payment_reference && <small>Payment reference: {order.payment_reference}</small>}<details className="event-history"><summary>Order history ({order.events.length})</summary>{order.events.map((event, index) => <div key={index}><StatusPill status={event.status} /><span>{event.note || "Order update"}</span><small>{event.created_at}</small></div>)}</details></article>)}</section></section></main>;
}

export default function App() {
	const [view, setView] = useState<"customer" | "admin">("customer");
	const match = window.location.pathname.match(/^\/track\/([^/]+)$/);
	if (match) return <><Header view="customer" setView={setView} /><TrackPage orderCode={decodeURIComponent(match[1])} token={new URLSearchParams(window.location.search).get("token") || ""} /><Footer /></>;
	return <><Header view={view} setView={setView} />{view === "customer" ? <CustomerPage /> : <AdminPage />}<Footer /></>;
}

function Footer() {
	return <footer><span>LELE Runner · SHEIN orders, verified quotes, tracking and customer updates</span><span className="design-credit">Application design by <strong>Paulic Designs</strong> · For advertisements and custom business applications</span></footer>;
}
