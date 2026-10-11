import { configure, getConfig, getStatus, replaceLocalWithAccount, requestSync, signIn, signOut, signUp, syncEvents } from "../sync";
import { h, toast } from "./dom";

function ago(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Text for the header chip. */
export function statusLabel(): string {
  const s = getStatus();
  switch (s.state) {
    case "off":
      return "Sync off";
    case "signed-out":
      return "Sign in to sync";
    case "syncing":
      return "Syncing…";
    case "offline":
      return "Offline";
    case "error":
    case "mismatch":
      return "Sync problem";
    default:
      return s.lastSync ? `Synced ${ago(s.lastSync)}` : "Synced";
  }
}

async function busy(button: HTMLButtonElement, fn: () => Promise<void>): Promise<void> {
  button.disabled = true;
  try {
    await fn();
  } catch (err) {
    toast((err as Error).message, "error");
  } finally {
    button.disabled = false;
  }
}

function configForm(): HTMLFormElement {
  const cfg = getConfig();
  const url = h("input", { type: "url", name: "url", required: true, placeholder: "https://xyz.supabase.co", value: cfg?.url ?? "" });
  const key = h("input", { type: "text", name: "key", required: true, placeholder: "eyJhbGciOi…", value: cfg?.anonKey ?? "", autocomplete: "off", spellcheck: false });
  const save = h("button.primary", { type: "submit", textContent: "Connect" });
  const form = h(
    "form.stack",
    {},
    h("p.muted", {}, "Connect a Supabase project to keep decks and progress in sync between your devices. ",
      "Run the SQL in ", h("code", { textContent: "supabase/migrations/" }), " on the project first (see the README)."),
    h("label.stacked", {}, h("span", { textContent: "Project URL" }), url),
    h("label.stacked", {}, h("span", { textContent: "Publishable (anon) key" }), key),
    h("div.dialog-actions", {}, save),
  );
  form.onsubmit = (e) => {
    e.preventDefault();
    void busy(save, () => configure({ url: url.value.trim().replace(/\/+$/, ""), anonKey: key.value.trim() }));
  };
  return form;
}

function signInForm(): HTMLElement {
  const email = h("input", { type: "email", name: "email", required: true, autocomplete: "username" });
  const password = h("input", { type: "password", name: "password", required: true, minLength: 8, autocomplete: "current-password" });
  const signInBtn = h("button.primary", { type: "submit", textContent: "Sign in" });
  const signUpBtn = h("button", { type: "button", textContent: "Create account" });
  const form = h(
    "form.stack",
    {},
    h("label.stacked", {}, h("span", { textContent: "Email" }), email),
    h("label.stacked", {}, h("span", { textContent: "Password" }), password),
    h("div.dialog-actions", {}, signUpBtn, signInBtn),
  );
  form.onsubmit = (e) => {
    e.preventDefault();
    void busy(signInBtn, () => signIn(email.value, password.value));
  };
  signUpBtn.onclick = () => {
    if (!form.reportValidity()) return;
    void busy(signUpBtn, async () => {
      const needsConfirm = await signUp(email.value, password.value);
      toast(needsConfirm ? "Check your email to confirm the account, then sign in." : "Account created");
    });
  };
  return h(
    "div",
    {},
    form,
    h("button.link.small-link", { type: "button", textContent: "Use a different Supabase project", onclick: () => void configure(undefined) }),
  );
}

function signedInView(): HTMLElement {
  const s = getStatus();
  const syncBtn = h("button.primary", { type: "button", textContent: "Sync now", onclick: () => requestSync(0) });
  const out = h("button", { type: "button", textContent: "Sign out" });
  out.onclick = () => void busy(out, signOut);
  const parts: (HTMLElement | string)[] = [
    h("p", {}, "Signed in as ", h("strong", { textContent: s.email ?? "?" })),
    h("p.muted", { textContent: statusLabel() }),
  ];
  if (s.state === "error") parts.push(h("p.error-text", { textContent: s.message ?? "Sync failed" }));
  if (s.state === "mismatch") {
    const replace = h("button.danger", { type: "button", textContent: "Erase this device and download my account" });
    replace.onclick = () => {
      if (!confirm("Erase all decks and progress stored on this device, then download this account's data?")) return;
      void busy(replace, replaceLocalWithAccount);
    };
    parts.push(
      h("p.error-text", { textContent: "This device already holds decks from a different account. To use this account here, erase the local copy first (the other account's cloud data is untouched)." }),
      replace,
    );
  }
  return h("div.stack", {}, ...parts, h("div.dialog-actions", {}, out, syncBtn));
}

export function openSyncDialog(): void {
  const body = h("div");
  const close = h("button.ghost.close", { type: "button", textContent: "✕", title: "Close", attrs: { "aria-label": "Close" } });
  const dialog = h("dialog.sync-dialog", {}, h("div.dialog-head", {}, h("h2", { textContent: "Sync" }), close), body);
  const render = () => {
    const state = getStatus().state;
    body.replaceChildren(state === "off" ? configForm() : state === "signed-out" ? signInForm() : signedInView());
  };
  render();
  syncEvents.addEventListener("status", render);
  close.onclick = () => dialog.close();
  dialog.onclose = () => {
    syncEvents.removeEventListener("status", render);
    dialog.remove();
  };
  document.body.append(dialog);
  dialog.showModal();
}
