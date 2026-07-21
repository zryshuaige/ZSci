import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { Annotation } from "@/lib/api";
import { cn } from "@/lib/cn";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

interface Selection {
  text: string;
  page: number;
  x: number;
  y: number;
  rects_json: string | null;
}

interface PdfReaderProps {
  paperId: string;
  pdfUrl: string;
  annotations: Annotation[];
  onTranslate: (text: string, page: number) => void;
  onAddNote: (text: string, page: number, rects_json: string | null) => void;
}

interface Rect {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

function parseFirstRect(rects_json: string | null): Rect | null {
  if (!rects_json) return null;
  try {
    const parsed = JSON.parse(rects_json);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed[0] as Rect;
    return null;
  } catch {
    return null;
  }
}

export default function PdfReader({
  pdfUrl,
  annotations,
  onTranslate,
  onAddNote,
}: PdfReaderProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [pageHeights, setPageHeights] = useState<Record<number, number>>({});
  // Reference page size at scale 1 (most PDFs are uniform); used to size
  // placeholders and to compute a fit-to-width render scale.
  const [basePage, setBasePage] = useState<{ w: number; h: number } | null>(null);
  // Fit-to-width scale is computed automatically from the container width.
  // `manualScale`, when set, overrides it (zoom buttons). `fitMode` tracks
  // whether we're in auto-fit or manual so the toolbar shows the right state.
  const [fitScale, setFitScale] = useState(1.0);
  const [manualScale, setManualScale] = useState<number | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [presetOpen, setPresetOpen] = useState(false);
  // The effective render scale: manual override wins, else auto-fit.
  const renderScale = manualScale ?? fitScale;
  // Track rendered pages so we don't render the same page twice (H2).
  const renderedRef = useRef<Set<number>>(new Set());
  // Generation guard: bumped whenever the render scale changes (or the doc is
  // torn down). An in-flight render captures the generation at start and aborts
  // (without writing stale state) if a newer generation supersedes it. This
  // replaces the old cancelRef Set, which couldn't tell a stale render from a
  // fresh one and so blocked the re-render we actually want on resize.
  const genRef = useRef(0);
  const inFlightRef = useRef<Map<number, number>>(new Map());
  // Zoom anchor: when the user zooms (button / shortcut / preset), we capture
  // the viewport center's document-space position BEFORE the scale change so
  // we can keep that same content centered AFTER. Without this, scaling up
  // anchors to the top-left and the viewed region "runs away" — the user only
  // sees a corner of the enlarged page. Because every page's size scales
  // linearly with renderScale, the new scroll position is exact:
  //   newScroll = (oldScroll + viewportHalf) * (newScale/oldScale) - viewportHalf
  const pendingZoomRef = useRef<{ ratio: number } | null>(null);

  // Unified zoom entrypoint. Clamps to [0.5, 3.0], records the anchor, then
  // sets manualScale. The post-scale scroll correction runs in the renderScale
  // effect below (after the new page sizes are committed to the DOM).
  const zoomTo = useCallback(
    (nextScale: number) => {
      const el = containerRef.current;
      const oldScale = manualScale ?? fitScale;
      const clamped = Math.max(0.5, Math.min(4.0, nextScale));
      if (el && clamped !== oldScale) {
        pendingZoomRef.current = { ratio: clamped / oldScale };
      }
      setManualScale(clamped);
    },
    [manualScale, fitScale],
  );

  // Two-stage zoom IN so the whole page stays visible as long as possible:
  //   stage 1 — page rail is visible: collapse it to reclaim ~112px of width.
  //              The container ResizeObserver fires, fitScale recomputes
  //              against the now-wider pane, and the page scales up WHILE
  //              still fitting the width (no horizontal scroll, full page
  //              visible, larger text). We leave manualScale null so the
  //              auto-fit drives the enlargement.
  //   stage 2 — rail already collapsed: actually raise manualScale above
  //              fitScale. The page now overflows the pane; the scroll-anchor
  //              correction keeps the viewed region centered instead of
  //              snapping to the top-left corner.
  const zoomIn = useCallback(() => {
    if (!railCollapsed) {
      setRailCollapsed(true);
      return;
    }
    zoomTo((manualScale ?? fitScale) + 0.15);
  }, [railCollapsed, manualScale, fitScale, zoomTo]);

  // Mirror of zoomIn: shrink manualScale back toward fit first, then expand
  // the page rail (pane narrows, page scales down but still fits width).
  const zoomOut = useCallback(() => {
    const cur = manualScale ?? fitScale;
    if (cur > fitScale + 0.001) {
      zoomTo(Math.max(fitScale, cur - 0.15));
      return;
    }
    // Already fitting width — give space back by expanding the rail.
    if (railCollapsed) setRailCollapsed(false);
  }, [railCollapsed, manualScale, fitScale, zoomTo]);

  // "Fit page": scale so the WHOLE page (both width and height) is visible.
  // Uses the smaller of the width-fit and height-fit ratios so neither
  // dimension overflows. Falls back to fit-width if the page height isn't
  // known yet.
  const zoomToFitPage = useCallback(() => {
    const el = containerRef.current;
    if (!el || !basePage) {
      setManualScale(null);
      return;
    }
    const oldScale = manualScale ?? fitScale;
    const padding = 24;
    const widthRatio = (el.clientWidth - padding) / basePage.w;
    const heightRatio = (el.clientHeight - padding) / basePage.h;
    const clamped = Math.max(0.5, Math.min(4.0, Math.min(widthRatio, heightRatio)));
    if (clamped !== oldScale) {
      pendingZoomRef.current = { ratio: clamped / oldScale };
    }
    setManualScale(clamped);
  }, [manualScale, fitScale, basePage]);

  useEffect(() => {
    let cancelled = false;
    pdfjsLib
      .getDocument({ url: pdfUrl })
      .promise.then((d) => {
        if (cancelled) {
          // H1: destroy the doc we loaded but won't use.
          d.destroy().catch(() => {});
          return;
        }
        setDoc(d);
        setNumPages(d.numPages);
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
      // Abort any in-flight renders by advancing the generation.
      genRef.current += 1;
      // H1: destroy the PDF document on unmount or pdfUrl change to release
      // memory. Previously the doc stayed in memory forever, and StrictMode's
      // double-mount in dev leaked a second doc.
      setDoc((prev) => {
        prev?.destroy().catch(() => {});
        return null;
      });
      renderedRef.current.clear();
      inFlightRef.current.clear();
    };
  }, [pdfUrl]);

  // Track the center pane width so we can fit pages to it (no big side gutters)
  // and recompute when the layout changes.
  // Depends on `doc` because the scroll container isn't rendered until the doc
  // finishes loading (the `if (!doc) return <loading>` early return above leaves
  // containerRef null on the first render). With `[]` deps the effect bailed on
  // mount and never re-ran, so containerWidth stayed 0 forever - fit-to-width
  // never engaged, basePage stayed null, pageW fell back to the fixed 620, and
  // every page was clipped to a 620px box (the "magnifying-glass on a small
  // part with big blank sides" bug).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setContainerWidth(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setContainerWidth(e.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [doc]);

  // Fit-to-width: once we know the page's native width and the container width,
  // pick a scale so the page fills the pane (minus padding). The lower clamp
  // is 0.5 (not 1.0) so narrow panes still fit — a standard letter PDF is 612pt
  // wide, and with the page rail + right panel eating width, the center pane on
  // a 1280px laptop can be ~560px; clamping at 1.0 made pageW (612) overflow the
  // container, cutting off the right edge while the page's left white margin
  // showed as "empty space". Allowing down to 0.5 keeps the page inside the pane.
  useEffect(() => {
    if (!doc || !containerWidth) return;
    let cancelled = false;
    (async () => {
      let bw = basePage?.w;
      if (bw == null) {
        const p1 = await doc.getPage(1);
        if (cancelled) return;
        const vp = p1.getViewport({ scale: 1 });
        bw = vp.width;
        setBasePage({ w: vp.width, h: vp.height });
      }
      const padding = 24; // p-3 on the scroll container = 12px each side
      const target = (containerWidth - padding) / bw;
      // Upper clamp 4.0 (was 3.0): on wide panes fit-to-width would otherwise
      // cap at 3.0 and leave the page narrower than the pane - big blank gutters
      // on the sides that zoom couldn't fill either. 4.0 lets the page actually
      // fill wide panes; lazy rendering keeps the perf cost bounded.
      const clamped = Math.max(0.5, Math.min(4.0, target));
      setFitScale(clamped);
    })();
    return () => {
      cancelled = true;
    };
  }, [doc, containerWidth, basePage]);

  const renderPage = useCallback(
    async (pageNum: number, canvas: HTMLCanvasElement, textLayerEl: HTMLElement) => {
      if (!doc || renderedRef.current.has(pageNum)) return;
      // A same-generation render is already in flight; a newer-generation one
      // (scale changed) supersedes it via the gen check below.
      const myGen = genRef.current;
      if (inFlightRef.current.get(pageNum) === myGen) return;
      inFlightRef.current.set(pageNum, myGen);
      try {
        const page = await doc.getPage(pageNum);
        if (genRef.current !== myGen) return; // superseded by a newer scale
        // Crispness: render the canvas backing store at renderScale * devicePixelRatio
        // so retina screens get real pixels, but keep CSS size at renderScale so the
        // text layer (which lives in CSS px) stays aligned with the displayed canvas.
        const dpr = window.devicePixelRatio || 1;
        const cssViewport = page.getViewport({ scale: renderScale });
        const backingViewport = page.getViewport({ scale: renderScale * dpr });
        canvas.width = backingViewport.width;
        canvas.height = backingViewport.height;
        canvas.style.width = `${cssViewport.width}px`;
        canvas.style.height = `${cssViewport.height}px`;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        await page.render({ canvasContext: ctx, viewport: backingViewport }).promise;
        if (genRef.current !== myGen) return;

        // Text layer for selection. Lives in CSS px to match the displayed canvas.
        textLayerEl.innerHTML = "";
        textLayerEl.style.width = `${cssViewport.width}px`;
        textLayerEl.style.height = `${cssViewport.height}px`;
        // --scale-factor matches the CSS render scale; the vended textLayer CSS
        // uses it for any calc()-based sizing.
        textLayerEl.style.setProperty("--scale-factor", String(renderScale));
        const textContent = await page.getTextContent();
        if (genRef.current !== myGen) return;
        const textLayer = new pdfjsLib.TextLayer({
          textContentSource: textContent,
          container: textLayerEl as HTMLElement,
          viewport: cssViewport,
        });
        try {
          await textLayer.render();
        } catch {
          /* text layer render is best-effort */
        }
        if (genRef.current !== myGen) return;
        setPageHeights((h) => ({ ...h, [pageNum]: cssViewport.height }));
        renderedRef.current.add(pageNum);
      } finally {
        if (inFlightRef.current.get(pageNum) === myGen) inFlightRef.current.delete(pageNum);
      }
    },
    [doc, renderScale]
  );

  // When the render scale changes, advance the generation so in-flight renders
  // abort, and invalidate every rendered page so visible pages re-render at the
  // new size (and the crispness/fit changes take effect). Also re-anchor the
  // scroll position so the content under the viewport center stays put —
  // without this, zooming in anchors to the top-left and the viewed region
  // "runs away" to a corner of the enlarged page.
  useEffect(() => {
    genRef.current += 1;
    renderedRef.current.clear();
    setPageHeights({});
    const anchor = pendingZoomRef.current;
    if (anchor) {
      pendingZoomRef.current = null;
      const el = containerRef.current;
      if (el) {
        const ratio = anchor.ratio;
        // Two rAFs: the first lets the placeholder heights (which depend on the
        // new renderScale via the inline style) commit to the DOM; the second
        // lets the browser recompute scrollWidth/Height. Then we scale the old
        // scroll offsets so the same document point stays centered.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            // Center-anchor: keep the document point under the viewport CENTER
            // fixed (not the top-left). This is what the comment above describes
            // and what every PDF reader does. The previous `scroll * ratio` form
            // anchored the top-left, so zooming past fit-width snapped the
            // viewport to a corner of the enlarged page - the user saw a
            // magnified corner (usually the white page margin) instead of the
            // text they were reading, which read as "magnifying-glass on a small
            // part with blank space beside it".
            const halfW = el.clientWidth / 2;
            const halfH = el.clientHeight / 2;
            el.scrollLeft = (el.scrollLeft + halfW) * ratio - halfW;
            el.scrollTop = (el.scrollTop + halfH) * ratio - halfH;
          });
        });
      }
    }
  }, [renderScale]);

  // H2: lazily render pages as they scroll into view via IntersectionObserver,
  // instead of pre-rendering every page up front (which blocked the UI on
  // large PDFs).
  useEffect(() => {
    if (!doc || !containerRef.current) return;
    const root = containerRef.current;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const el = entry.target as HTMLElement;
          const pageNum = Number(el.dataset.page);
          if (!pageNum) continue;
          const canvas = el.querySelector<HTMLCanvasElement>(`canvas[data-page="${pageNum}"]`);
          const textLayerEl = el.querySelector<HTMLElement>(`[data-text-layer="${pageNum}"]`);
          if (canvas && textLayerEl) void renderPage(pageNum, canvas, textLayerEl);
        }
      },
      { root, rootMargin: "200px" }
    );
    const pages = root.querySelectorAll<HTMLElement>("[data-page-container]");
    pages.forEach((p) => observer.observe(p));
    return () => observer.disconnect();
  }, [doc, numPages, renderPage]);

  // Track which page is centered in the viewport so the rail highlights it and
  // the toolbar can show "5 / 24". Throttled via rAF so it stays smooth.
  useEffect(() => {
    if (!doc || !containerRef.current) return;
    const root = containerRef.current;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const viewportMid = root.scrollTop + root.clientHeight / 2;
        let top = 0;
        let page = 1;
        const ph = (basePage?.h ?? 800 / 1.4) * renderScale;
        for (let i = 1; i <= numPages; i++) {
          const h = pageHeights[i] || ph;
          if (top + h >= viewportMid) { page = i; break; }
          top += h + 12;
          page = i;
        }
        setCurrentPage(page);
      });
    };
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      root.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
  }, [doc, numPages, pageHeights, basePage, renderScale]);

  // Keyboard zoom shortcuts: Cmd/Ctrl + / - / 0. Standard PDF-reader convention
  // so users don't have to hunt for the floating toolbar. 0 = fit-to-width
  // (resets manualScale so the auto-fit scale takes over).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        zoomIn();
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        zoomOut();
      } else if (e.key === "0") {
        e.preventDefault();
        setManualScale(null);
        setRailCollapsed(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomIn, zoomOut]);

  const handleMouseUp = (e: React.MouseEvent) => {
    const sel = window.getSelection();
    const text = sel?.toString().trim();
    if (!text || text.length < 2) {
      setSelection(null);
      return;
    }
    let page = 1;
    let rectsJson: string | null = null;
    const node = sel?.anchorNode;
    const pageEl = node
      ? (node.parentElement?.closest("[data-page]") as HTMLElement | null)
      : null;
    if (pageEl) {
      page = Number(pageEl.dataset.page);
      // Capture the first selection rect relative to the page container so a
      // highlight overlay can be persisted (matches the annotation rects_json
      // schema). Without this, annotations are saved with no geometry and the
      // overlay renders a 0x0 box.
      const range = sel?.getRangeAt(0);
      if (range) {
        const pageBox = pageEl.getBoundingClientRect();
        const rect = range.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          rectsJson = JSON.stringify([
            {
              x: rect.left - pageBox.left,
              y: rect.top - pageBox.top,
              w: rect.width,
              h: rect.height,
            },
          ]);
        }
      }
    }
    setSelection({ text, page, x: e.clientX, y: e.clientY, rects_json: rectsJson });
  };

  function pageTopOffset(pageNum: number) {
    // Match the placeholder height used in the container style so the scroll
    // offset is correct even for pages not yet rendered.
    const ph = (basePage?.h ?? 800 / 1.4) * renderScale;
    let top = 0;
    for (let i = 1; i < pageNum; i++) top += (pageHeights[i] || ph) + 12;
    return top;
  }

  function scrollPage(pageNum: number) {
    const c = containerRef.current;
    if (c) c.scrollTop = pageTopOffset(pageNum);
  }

  if (error) return <div className="p-4 text-destructive">PDF 加载失败:{error}</div>;
  if (!doc) return <div className="p-4">加载 PDF…</div>;

  // Page pixel size at the current render scale. Falls back to the pane width
  // (not a fixed 620) before basePage is measured, so the container is pane-wide
  // during the brief transient instead of a fixed 620px box that clips the
  // canvas and shows blank sides.
  const pageW = basePage ? basePage.w * renderScale : containerWidth || 620;
  const placeholderH = basePage ? basePage.h * renderScale : 800;
  const zoomPct = Math.round(renderScale * 100);

  return (
    <div className="flex h-full relative">
      {/* Left rail: page list (collapsible to reclaim width on narrow panes) */}
      {!railCollapsed && (
        <div className="w-28 shrink-0 border-r border-border/60 glass overflow-auto p-2 space-y-1 text-xs">
          {Array.from({ length: numPages }, (_, i) => i + 1).map((p) => (
            <button
              key={p}
              onClick={() => scrollPage(p)}
              className={cn(
                "block w-full text-left rounded-md px-2 py-1.5 transition-colors duration-sm ease-out",
                p === currentPage
                  ? "bg-primary/10 text-primary font-medium"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              第 {p} 页
              {annotations.some((a) => a.page_number === p) && (
                <span className="ml-1 text-amber-500">●</span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Center: PDF */}
      <div
        ref={containerRef}
        onMouseUp={handleMouseUp}
        className="flex-1 overflow-auto bg-muted/30 p-3"
      >
        <div className="mx-auto" style={{ width: pageW }}>
          {Array.from({ length: numPages }, (_, i) => i + 1).map((p) => (
            <div
              key={p}
              data-page={p}
              data-page-container={p}
              className="relative mb-3 shadow-soft bg-white rounded-sm overflow-hidden"
              // Size to the real rendered viewport once known; before render,
              // keep a stable height so the IntersectionObserver has a target
              // to latch onto and the page rail's offset math is correct.
              style={{ width: pageW, height: pageHeights[p] || placeholderH }}
            >
              <canvas data-page={p} className="block" />
              <div
                data-text-layer={p}
                className="textLayer absolute inset-0 overflow-hidden"
              />
              {/* Highlight overlays for this page. M3: parse rects_json once per
                  annotation instead of four times. */}
              {annotations
                .filter((a) => a.page_number === p && a.rects_json)
                .map((a) => {
                  const rect = parseFirstRect(a.rects_json);
                  return (
                    <div
                      key={a.id}
                      className="absolute pointer-events-none"
                      style={{
                        left: `${rect?.x ?? 0}px`,
                        top: `${rect?.y ?? 0}px`,
                        width: `${rect?.w ?? 0}px`,
                        height: `${rect?.h ?? 0}px`,
                        background: a.color || "#fde047",
                        opacity: 0.4,
                      }}
                    />
                  );
                })}
            </div>
          ))}
        </div>
      </div>

      {/* Floating toolbar (Apple-style glass): page rail toggle + zoom + page
          indicator. Sits bottom-center over the PDF like a HUD. */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1 rounded-full border border-border/60 glass-strong shadow-float px-1.5 py-1 text-sm">
        <button
          onClick={() => setRailCollapsed((v) => !v)}
          className="h-7 w-7 inline-flex items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground transition-colors duration-sm ease-out"
          title={railCollapsed ? "显示页码栏" : "隐藏页码栏"}
        >
          {railCollapsed ? "▸" : "◂"}
        </button>
        <div className="w-px h-4 bg-border/60 mx-0.5" />
        <button
          onClick={() => zoomOut()}
          className="h-7 w-7 inline-flex items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground transition-colors duration-sm ease-out active:scale-90"
          title="缩小 (Cmd/Ctrl -)"
        >
          −
        </button>
        {/* Zoom preset dropdown: click the percentage to pick fit-width /
            100% actual size / fit-page. Defaults to a simple reset on the
            percentage label, with a chevron to signal it's a menu. */}
        <div className="relative">
          <button
            onClick={() => setPresetOpen((v) => !v)}
            className="h-7 px-2 inline-flex items-center gap-0.5 rounded-full text-xs tabular-nums text-muted-foreground hover:bg-muted hover:text-foreground transition-colors duration-sm ease-out"
            title="缩放预设"
          >
            {zoomPct}%
            <ChevronDown className="h-3 w-3" />
          </button>
          {presetOpen && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setPresetOpen(false)} />
              <div className="absolute left-1/2 -translate-x-1/2 bottom-full mb-2 z-40 w-40 rounded-xl border border-border bg-card shadow-float p-1.5 animate-pop origin-bottom">
                <button
                  onClick={() => { setManualScale(null); setRailCollapsed(false); setPresetOpen(false); }}
                  className="w-full text-left rounded-lg px-3 py-2 text-xs hover:bg-muted transition-colors duration-sm ease-out"
                >
                  适合宽度
                  <span className="text-muted-foreground block">贴合面板宽度</span>
                </button>
                <button
                  onClick={() => { zoomTo(1.0); setPresetOpen(false); }}
                  className="w-full text-left rounded-lg px-3 py-2 text-xs hover:bg-muted transition-colors duration-sm ease-out"
                >
                  实际大小
                  <span className="text-muted-foreground block">100%</span>
                </button>
                <button
                  onClick={() => { zoomToFitPage(); setPresetOpen(false); }}
                  className="w-full text-left rounded-lg px-3 py-2 text-xs hover:bg-muted transition-colors duration-sm ease-out"
                >
                  适合页面
                  <span className="text-muted-foreground block">整页可见</span>
                </button>
              </div>
            </>
          )}
        </div>
        <button
          onClick={() => zoomIn()}
          className="h-7 w-7 inline-flex items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground transition-colors duration-sm ease-out active:scale-90"
          title="放大 (Cmd/Ctrl +)"
        >
          +
        </button>
        <div className="w-px h-4 bg-border/60 mx-0.5" />
        <span className="px-2 text-xs tabular-nums text-muted-foreground">
          {currentPage} / {numPages}
        </span>
      </div>

      {/* Selection popover */}
      {selection && (
        <div
          className="fixed z-40 bg-card border border-border rounded-lg shadow-float p-1 flex gap-1 animate-pop"
          style={{
            left: Math.min(selection.x, (typeof window !== "undefined" ? window.innerWidth : 9999) - 200),
            top: selection.y + 16,
          }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <button
            className="px-2.5 py-1.5 text-xs hover:bg-muted rounded-md transition-colors duration-sm ease-out"
            onClick={() => {
              onTranslate(selection.text, selection.page);
              setSelection(null);
            }}
          >
            翻译为中文
          </button>
          <button
            className="px-2.5 py-1.5 text-xs hover:bg-muted rounded-md transition-colors duration-sm ease-out"
            onClick={() => {
              onAddNote(selection.text, selection.page, selection.rects_json);
              setSelection(null);
            }}
          >
            加入笔记
          </button>
          <button
            className="px-2 py-1.5 text-xs hover:bg-muted rounded-md transition-colors duration-sm ease-out"
            onClick={() => setSelection(null)}
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
