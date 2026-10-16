// PiP's remembered floating size. CSS alone clamps it when the viewport shrinks, without losing the preference.
import { useEffect } from "preact/hooks";

export function usePipResize(ref, account) {
    useEffect(() => {
        const panel = ref.current;

        if (!panel || !account) {
            return;
        }

        const key = `pocket.pip.size.${account}`;

        panel.style.removeProperty("--pip-width");
        panel.style.removeProperty("--pip-height");

        const size = (width, height) => {
            panel.style.setProperty("--pip-width", `${width}px`);
            panel.style.setProperty("--pip-height", `${height}px`);
        };

        try {
            const saved = JSON.parse(localStorage.getItem(key));

            if (Number.isFinite(saved?.width) && Number.isFinite(saved?.height)) {
                size(Math.max(420, Math.min(800, saved.width)), Math.max(360, saved.height));
            }
        } catch {
            // A missing or invalid preference uses the normal CSS size.
        }

        let drag = null;

        const stop = () => {
            if (drag) {
                const { id, selection } = drag;

                drag = null;
                document.documentElement.style.userSelect = selection;

                if (panel.hasPointerCapture(id)) {
                    panel.releasePointerCapture(id);
                }
            }
        };

        const down = (event) => {
            const edge = event.target.closest("[data-pip-resize]")?.dataset.pipResize;

            if (!edge || event.button !== 0 || innerWidth < 768 || drag) {
                return;
            }

            event.preventDefault();
            const rect = panel.getBoundingClientRect();
            const style = getComputedStyle(panel);

            drag = {
                id: event.pointerId,
                x: event.clientX,
                y: event.clientY,
                width: rect.width,
                height: rect.height,
                maxWidth: parseFloat(style.maxWidth),
                maxHeight: parseFloat(style.maxHeight),
                edge,
                selection: document.documentElement.style.userSelect,
            };
            document.documentElement.style.userSelect = "none";
            panel.setPointerCapture(event.pointerId);
        };

        const move = (event) => {
            if (!drag || event.pointerId !== drag.id) {
                return;
            }

            const width = drag.edge === "top" ? drag.width : drag.width + drag.x - event.clientX;
            const height =
                drag.edge === "left" ? drag.height : drag.height + drag.y - event.clientY;

            size(
                Math.min(drag.maxWidth, Math.max(420, width)),
                Math.min(drag.maxHeight, Math.max(360, height)),
            );
        };

        const up = (event) => {
            if (!drag || event.pointerId !== drag.id) {
                return;
            }

            const rect = panel.getBoundingClientRect();

            try {
                localStorage.setItem(
                    key,
                    JSON.stringify({ width: rect.width, height: rect.height }),
                );
            } catch {
                // Resizing still works when browser storage is unavailable.
            }

            stop();
        };

        addEventListener("resize", stop);
        panel.addEventListener("pointerdown", down);
        panel.addEventListener("pointermove", move);
        panel.addEventListener("pointerup", up);
        panel.addEventListener("lostpointercapture", stop);
        panel.addEventListener("pointercancel", stop);

        return () => {
            stop();
            removeEventListener("resize", stop);
            panel.removeEventListener("pointerdown", down);
            panel.removeEventListener("pointermove", move);
            panel.removeEventListener("pointerup", up);
            panel.removeEventListener("lostpointercapture", stop);
            panel.removeEventListener("pointercancel", stop);
        };
    }, [account]);
}
