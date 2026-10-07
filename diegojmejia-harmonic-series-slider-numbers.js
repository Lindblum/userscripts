// ==UserScript==
// @author       Lindblum
// @name         Harmonic Series Online Visualizer Slider Numbers
// @namespace    https://harmonicseries.diegojmejia.com
// @match        https://harmonicseries.diegojmejia.com
// @version      1.1
// @description  Number fields for each .card-slider, plus a paste-a-list field for harmonic amplitudes.
// @icon         data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==
// @grant        none
// ==/UserScript==
(() => {
    if (window.__sliderNumberInputs) {
        console.log("Slider number inputs already installed.");
        return;
    }

    const valueDesc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");

    const style = document.createElement("style");
    style.textContent = `
        .card-slider-number {
            width: 5.5em;
            margin-left: 0.5em;
            padding: 2px 4px;
            font: inherit;
            font-size: 0.9em;
            box-sizing: border-box;
        }
    `;
    document.head.appendChild(style);

    function decimalsFor(step) {
        const s = String(step);
        return s.includes(".") ? s.split(".")[1].length : 0;
    }

    function attach(slider) {
        if (slider.dataset.numberInput) return;
        slider.dataset.numberInput = "1";

        const num = document.createElement("input");
        num.type = "number";
        num.className = "card-slider-number";
        num.min = slider.min;
        num.max = slider.max;
        num.step = slider.step || "any";
        const decimals = decimalsFor(slider.step || 1);

        const show = () => {
            if (document.activeElement === num) return; // don't clobber while typing
            num.value = Number(valueDesc.get.call(slider)).toFixed(decimals);
        };

        const commit = () => {
            let v = parseFloat(num.value);
            if (Number.isNaN(v)) return show();
            v = Math.min(Number(slider.max), Math.max(Number(slider.min), v));
            valueDesc.set.call(slider, v);
            // Fire the events the app listens for so audio/labels/graph update.
            slider.dispatchEvent(new Event("input", { bubbles: true }));
            slider.dispatchEvent(new Event("change", { bubbles: true }));
            num.blur();
            show();
        };

        // Keep the field in sync when the app sets slider.value in code (e.g. presets).
        Object.defineProperty(slider, "value", {
            configurable: true,
            get() { return valueDesc.get.call(this); },
            set(v) { valueDesc.set.call(this, v); show(); },
        });

        slider.addEventListener("input", show);
        slider.addEventListener("change", show);
        num.addEventListener("change", commit);
        num.addEventListener("keydown", (e) => {
            e.stopPropagation(); // keep typing from triggering the computer-keyboard piano
            if (e.key === "Enter") commit();
            if (e.key === "Escape") { num.blur(); show(); }
        });
        num.addEventListener("keyup", (e) => e.stopPropagation());
        num.addEventListener("blur", show);

        slider.insertAdjacentElement("afterend", num);
        show();
    }

    const scan = (root) => {
        if (root.nodeType !== 1) return;
        if (root.matches(".card-slider")) attach(root);
        root.querySelectorAll(".card-slider").forEach(attach);
    };

    // ---- Paste-a-list field: sets the number of harmonic rows and their amplitudes ----

    const nextFrame = () => new Promise((r) => requestAnimationFrame(r));
    const harmonicRows = () => document.querySelectorAll("#harmonics-container .harmonic-row");

    // Click Add/Remove until the row count matches (rows may be added asynchronously).
    async function setRowCount(n) {
        const add = document.getElementById("harmonic-add");
        const remove = document.getElementById("harmonic-remove");
        for (let guard = 0; harmonicRows().length !== n && guard < 500; guard++) {
            const before = harmonicRows().length;
            (before < n ? add : remove).click();
            for (let i = 0; i < 30 && harmonicRows().length === before; i++) await nextFrame();
            if (harmonicRows().length === before) break; // button had no effect (e.g. at a limit)
        }
        return harmonicRows().length;
    }

    async function applyList(text, status) {
        // Split on commas, tabs, whitespace, or semicolons; ignore non-numeric tokens
        // such as an instrument name at the start of a CSV row.
        const values = text.split(/[,\t;\s]+/).filter((t) => t !== "" && !Number.isNaN(Number(t))).map(Number);
        if (!values.length) {
            status.textContent = "No numbers found.";
            return;
        }

        const count = await setRowCount(values.length);
        harmonicRows().forEach((row, i) => {
            if (i >= values.length) return;
            const slider = row.querySelector(".harmonic-volume-slider");
            if (!slider) return;
            const v = Math.min(Number(slider.max), Math.max(Number(slider.min), values[i]));
            slider.value = v; // goes through the patched setter, which refreshes the number field
            slider.dispatchEvent(new Event("input", { bubbles: true }));
            slider.dispatchEvent(new Event("change", { bubbles: true }));
        });

        status.textContent = count === values.length
            ? `Applied ${values.length} values.`
            : `Applied ${Math.min(count, values.length)} of ${values.length} values (only ${count} harmonic rows could be created).`;
    }

    function addListField() {
        const controls = document.getElementById("harmonics-controls");
        if (!controls || document.getElementById("harmonic-list-container")) return;

        style.textContent += `
            #harmonic-list-container { display: flex; flex-wrap: wrap; gap: 0.5em; align-items: center; margin-bottom: 0.75em; }
            #harmonic-list-input { flex: 1 1 100%; width: 100%; box-sizing: border-box; padding: 4px 6px; font: inherit; }
            #harmonic-list-status { font-size: 0.85em; opacity: 0.8; }
        `;

        const box = document.createElement("div");
        box.id = "harmonic-list-container";
        box.className = "card-subcontainer";
        box.innerHTML = `
            <label class="card-bolded-text" for="harmonic-list-input">Paste Amplitudes (comma or tab separated):</label>
            <input type="text" id="harmonic-list-input" placeholder="e.g. 1, 0.5, 0.333, 0.25">
            <button id="harmonic-list-apply" class="card-button">Apply</button>
            <span id="harmonic-list-status"></span>
        `;
        controls.prepend(box);

        const input = box.querySelector("#harmonic-list-input");
        const button = box.querySelector("#harmonic-list-apply");
        const status = box.querySelector("#harmonic-list-status");

        const run = async () => {
            button.disabled = true;
            try { await applyList(input.value, status); } finally { button.disabled = false; }
        };
        button.addEventListener("click", run);
        input.addEventListener("keydown", (e) => {
            e.stopPropagation(); // keep typing from triggering the computer-keyboard piano
            if (e.key === "Enter") run();
        });
        input.addEventListener("keyup", (e) => e.stopPropagation());
    }

    addListField();
    scan(document.body);

    const observer = new MutationObserver((mutations) => {
        for (const m of mutations) m.addedNodes.forEach(scan);
    });
    observer.observe(document.body, { childList: true, subtree: true });

    window.__sliderNumberInputs = { observer, style };
    console.log(`Slider number inputs installed on ${document.querySelectorAll(".card-slider").length} sliders.`);
})();
