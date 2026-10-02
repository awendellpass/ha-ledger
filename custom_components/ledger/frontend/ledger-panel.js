class LedgerPanel extends HTMLElement {
  constructor() {
    super();
    this._iframe = null;
  }

  set hass(hass) {
    const token = hass.auth.data.access_token;
    if (!this._iframe) {
      this._iframe = document.createElement("iframe");
      this._iframe.src = "/ledger_frontend/ledger-app.html";
      Object.assign(this._iframe.style, {
        width: "100%", height: "100%", border: "none", display: "block",
      });
      this.appendChild(this._iframe);
      this._iframe.addEventListener("load", () => {
        this._iframe.contentWindow.postMessage({ type: "auth", token }, "*");
      });
    } else {
      this._iframe.contentWindow?.postMessage({ type: "auth", token }, "*");
    }
  }

  connectedCallback() {
    this.style.cssText = "display:block;height:100vh;overflow:hidden;";
  }
}

customElements.define("ledger-panel", LedgerPanel);
