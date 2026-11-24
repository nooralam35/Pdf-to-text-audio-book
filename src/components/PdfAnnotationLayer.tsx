import React, { useEffect, useMemo, useRef, useState } from 'react';
import { GripVertical, Trash2, X } from 'lucide-react';
import type {
  AnnotationPoint,
  AnnotationStroke,
  AnnotationTool,
  StickyNote,
} from '../types';

export const NOTE_PALETTE: Record<
  StickyNote['color'],
  { label: string; pin: string; cardBg: string; cardBorder: string; text: string }
> = {
  amber: {
    label: 'Warm Amber',
    pin: 'bg-amber-500 text-stone-950 border-amber-700',
    cardBg: 'bg-[#FFF9E6] dark:bg-[#2A2414]',
    cardBorder: 'border-amber-300 dark:border-amber-700/80',
    text: 'text-stone-900 dark:text-amber-50',
  },
  sage: {
    label: 'Sage',
    pin: 'bg-emerald-500 text-stone-950 border-emerald-700',
    cardBg: 'bg-[#EFFAF3] dark:bg-[#14271D]',
    cardBorder: 'border-emerald-300 dark:border-emerald-700/80',
    text: 'text-stone-900 dark:text-emerald-50',
  },
  sky: {
    label: 'Sky',
    pin: 'bg-sky-500 text-white border-sky-700',
    cardBg: 'bg-[#F0F8FF] dark:bg-[#14222E]',
    cardBorder: 'border-sky-300 dark:border-sky-700/80',
    text: 'text-stone-900 dark:text-sky-50',
  },
  rose: {
    label: 'Rose',
    pin: 'bg-rose-500 text-white border-rose-700',
    cardBg: 'bg-[#FFF1F3] dark:bg-[#2C161B]',
    cardBorder: 'border-rose-300 dark:border-rose-700/80',
    text: 'text-stone-900 dark:text-rose-50',
  },
};

interface PdfAnnotationLayerProps {
  width: number;
  height: number;
  tool: AnnotationTool;
  strokeColor: string;
  strokeWidth: number;
  strokeOpacity: number;
  noteColor: StickyNote['color'];
  visible: boolean;
  strokes: AnnotationStroke[];
  notes: StickyNote[];
  activeNoteId: string | null;
  onSelectNote: (noteId: string | null) => void;
  onAddStroke: (stroke: AnnotationStroke, canvasSnapshot?: string) => void;
  onEraseStroke: (strokeId: string, canvasSnapshot?: string) => void;
  onAddNote: (x: number, y: number, color: StickyNote['color']) => void;
  onUpdateNote: (
    noteId: string,
    patch: Partial<Pick<StickyNote, 'text' | 'x' | 'y' | 'color'>>
  ) => void;
  onDeleteNote: (noteId: string) => void;
}

function drawStrokeOnCanvas(
  ctx: CanvasRenderingContext2D,
  stroke: AnnotationStroke,
  w: number,
  h: number,
  scaleFactor: number
) {
  const pts = stroke.points;
  if (pts.length === 0) return;

  const opacity =
    typeof stroke.opacity === 'number'
      ? Math.max(0.05, Math.min(1, stroke.opacity))
      : stroke.mode === 'highlight'
      ? 0.4
      : 0.95;

  const brushPx = Math.max(1, stroke.width * scaleFactor);

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.strokeStyle = stroke.color;
  ctx.fillStyle = stroke.color;
  ctx.lineWidth = brushPx;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (pts.length === 1) {
    ctx.beginPath();
    ctx.arc(pts[0].x * w, pts[0].y * h, brushPx / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  ctx.beginPath();
  ctx.moveTo(pts[0].x * w, pts[0].y * h);
  for (let i = 1; i < pts.length - 1; i++) {
    const cx = pts[i].x * w;
    const cy = pts[i].y * h;
    const midX = (cx + pts[i + 1].x * w) / 2;
    const midY = (cy + pts[i + 1].y * h) / 2;
    ctx.quadraticCurveTo(cx, cy, midX, midY);
  }
  const last = pts[pts.length - 1];
  ctx.lineTo(last.x * w, last.y * h);
  ctx.stroke();
  ctx.restore();
}

export function renderStrokesToDataUrl(
  strokes: AnnotationStroke[],
  w: number,
  h: number
): string | undefined {
  if (strokes.length === 0 || w <= 0 || h <= 0) return undefined;
  const targetW = Math.min(900, Math.max(320, Math.round(w)));
  const targetH = Math.max(320, Math.round((targetW * h) / w));
  const scaleFactor = targetW / 540;

  const off = document.createElement('canvas');
  off.width = targetW;
  off.height = targetH;
  const ctx = off.getContext('2d');
  if (!ctx) return undefined;

  for (const s of strokes) {
    drawStrokeOnCanvas(ctx, s, targetW, targetH, scaleFactor);
  }
  return off.toDataURL('image/png');
}

function distToSegmentSq(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    return (px - x1) ** 2 + (py - y1) ** 2;
  }
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
  const projX = x1 + t * dx;
  const projY = y1 + t * dy;
  return (px - projX) ** 2 + (py - projY) ** 2;
}

export const PdfAnnotationLayer: React.FC<PdfAnnotationLayerProps> = ({
  width,
  height,
  tool,
  strokeColor,
  strokeWidth,
  strokeOpacity,
  noteColor,
  visible,
  strokes,
  notes,
  activeNoteId,
  onSelectNote,
  onAddStroke,
  onEraseStroke,
  onAddNote,
  onUpdateNote,
  onDeleteNote,
}) => {
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const highlightCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const penCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const [draftStroke, setDraftStroke] = useState<AnnotationStroke | null>(null);
  const isErasingRef = useRef(false);
  const draggingNoteRef = useRef<{
    id: string;
    moved: boolean;
    startX: number;
    startY: number;
  } | null>(null);

  const safeW = Math.max(1, Math.round(width));
  const safeH = Math.max(1, Math.round(height));
  // Keep brush thickness proportional to PDF page zoom
  const scaleFactor = safeW / 540;

  const allStrokes = useMemo(
    () => (draftStroke ? [...strokes, draftStroke] : strokes),
    [strokes, draftStroke]
  );

  // Paint strokes onto dedicated HiDPI HTML5 <canvas> layers (multiply highlighter + freehand brush)
  useEffect(() => {
    if (!visible || width <= 0 || height <= 0) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const paintCanvas = (
      canvas: HTMLCanvasElement | null,
      mode: 'highlight' | 'pen'
    ) => {
      if (!canvas) return;
      const targetPixelW = Math.max(1, Math.round(safeW * dpr));
      const targetPixelH = Math.max(1, Math.round(safeH * dpr));
      if (canvas.width !== targetPixelW || canvas.height !== targetPixelH) {
        canvas.width = targetPixelW;
        canvas.height = targetPixelH;
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, safeW, safeH);

      for (const stroke of allStrokes) {
        if (stroke.mode === mode) {
          drawStrokeOnCanvas(ctx, stroke, safeW, safeH, scaleFactor);
        }
      }
    };

    paintCanvas(highlightCanvasRef.current, 'highlight');
    paintCanvas(penCanvasRef.current, 'pen');
  }, [allStrokes, safeW, safeH, scaleFactor, visible, width, height]);

  const getNormalizedPoint = (e: React.PointerEvent): AnnotationPoint => {
    const rect = overlayRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) {
      return { x: 0.5, y: 0.5 };
    }
    return {
      x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
    };
  };

  const tryEraseAtPoint = (pt: AnnotationPoint) => {
    const px = pt.x * safeW;
    const py = pt.y * safeH;
    const hitRadius = Math.max(12, 14 * scaleFactor);

    for (let i = strokes.length - 1; i >= 0; i--) {
      const s = strokes[i];
      const thresholdSq = (hitRadius + (s.width * scaleFactor) / 2) ** 2;
      const pts = s.points;
      if (pts.length === 1) {
        const dSq = (px - pts[0].x * safeW) ** 2 + (py - pts[0].y * safeH) ** 2;
        if (dSq <= thresholdSq) {
          const remaining = strokes.filter((st) => st.id !== s.id);
          onEraseStroke(s.id, renderStrokesToDataUrl(remaining, safeW, safeH));
          return;
        }
      }
      for (let j = 0; j < pts.length - 1; j++) {
        const dSq = distToSegmentSq(
          px,
          py,
          pts[j].x * safeW,
          pts[j].y * safeH,
          pts[j + 1].x * safeW,
          pts[j + 1].y * safeH
        );
        if (dSq <= thresholdSq) {
          const remaining = strokes.filter((st) => st.id !== s.id);
          onEraseStroke(s.id, renderStrokesToDataUrl(remaining, safeW, safeH));
          return;
        }
      }
    }
  };

  const handleSurfacePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!visible) return;
    if (e.button !== 0 && e.pointerType === 'mouse') return;

    if ((e.target as HTMLElement).closest('[data-sticky-ui="true"]')) {
      return;
    }

    if (tool === 'cursor') {
      if (activeNoteId) onSelectNote(null);
      return;
    }

    const pt = getNormalizedPoint(e);

    if (tool === 'note') {
      e.preventDefault();
      onAddNote(pt.x, pt.y, noteColor);
      return;
    }

    if (tool === 'eraser') {
      e.preventDefault();
      isErasingRef.current = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      tryEraseAtPoint(pt);
      return;
    }

    if (tool === 'highlight' || tool === 'pen') {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      if (activeNoteId) onSelectNote(null);
      const newStroke: AnnotationStroke = {
        id: `str-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        mode: tool,
        color: strokeColor,
        width: strokeWidth,
        opacity: strokeOpacity,
        points: [pt],
      };
      setDraftStroke(newStroke);
    }
  };

  const handleSurfacePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isErasingRef.current && tool === 'eraser') {
      tryEraseAtPoint(getNormalizedPoint(e));
      return;
    }

    if (draftStroke) {
      const pt = getNormalizedPoint(e);
      setDraftStroke((prev) => {
        if (!prev) return null;
        const last = prev.points[prev.points.length - 1];
        if (last && Math.hypot((pt.x - last.x) * safeW, (pt.y - last.y) * safeH) < 2.0) {
          return prev;
        }
        return { ...prev, points: [...prev.points, pt] };
      });
    }
  };

  const handleSurfacePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isErasingRef.current) {
      isErasingRef.current = false;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      return;
    }

    if (draftStroke) {
      const finished = draftStroke;
      setDraftStroke(null);
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      if (finished.points.length > 0) {
        const snapshot = renderStrokesToDataUrl([...strokes, finished], safeW, safeH);
        onAddStroke(finished, snapshot);
      }
    }
  };

  if (!visible || width <= 0 || height <= 0) return null;

  const isInteractiveTool = tool !== 'cursor';
  const cursorClass =
    tool === 'highlight' || tool === 'pen'
      ? 'cursor-crosshair'
      : tool === 'note'
      ? 'cursor-copy'
      : tool === 'eraser'
      ? 'cursor-not-allowed'
      : 'cursor-default';

  return (
    <div
      ref={overlayRef}
      onPointerDown={handleSurfacePointerDown}
      onPointerMove={handleSurfacePointerMove}
      onPointerUp={handleSurfacePointerUp}
      onPointerCancel={handleSurfacePointerUp}
      className={`absolute inset-0 z-10 select-none ${cursorClass} ${
        isInteractiveTool ? 'touch-none' : ''
      }`}
    >
      {/* HTML5 Canvas Layer 1: Translucent Highlighter (multiply blend keeps diagram text crisp) */}
      <canvas
        ref={highlightCanvasRef}
        style={{ mixBlendMode: 'multiply' }}
        className="absolute inset-0 w-full h-full pointer-events-none"
      />

      {/* HTML5 Canvas Layer 2: Freehand Brush / Pen Annotation Canvas */}
      <canvas
        ref={penCanvasRef}
        className="absolute inset-0 w-full h-full pointer-events-none"
      />

      {/* Sticky Note Pins & Popovers */}
      {notes.map((note, index) => {
        const theme = NOTE_PALETTE[note.color] ?? NOTE_PALETTE.amber;
        const isOpen = activeNoteId === note.id;
        const flipLeft = note.x > 0.56;
        const flipUp = note.y > 0.62;

        return (
          <div
            key={note.id}
            data-sticky-ui="true"
            style={{
              left: `${note.x * 100}%`,
              top: `${note.y * 100}%`,
            }}
            className="absolute -translate-x-1/2 -translate-y-1/2 z-20"
          >
            {/* Draggable Numbered Pin */}
            <button
              type="button"
              onPointerDown={(e) => {
                e.stopPropagation();
                e.currentTarget.setPointerCapture(e.pointerId);
                draggingNoteRef.current = {
                  id: note.id,
                  moved: false,
                  startX: e.clientX,
                  startY: e.clientY,
                };
              }}
              onPointerMove={(e) => {
                const drag = draggingNoteRef.current;
                if (!drag || drag.id !== note.id) return;
                e.stopPropagation();
                const dist = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY);
                if (dist > 4) {
                  drag.moved = true;
                  const pt = getNormalizedPoint(e);
                  onUpdateNote(drag.id, {
                    x: Math.max(0.03, Math.min(0.97, pt.x)),
                    y: Math.max(0.03, Math.min(0.97, pt.y)),
                  });
                }
              }}
              onPointerUp={(e) => {
                const drag = draggingNoteRef.current;
                if (!drag || drag.id !== note.id) return;
                e.stopPropagation();
                try {
                  e.currentTarget.releasePointerCapture(e.pointerId);
                } catch {
                  // ignore
                }
                const wasDragged = drag.moved;
                draggingNoteRef.current = null;
                if (!wasDragged) {
                  onSelectNote(isOpen ? null : note.id);
                }
              }}
              onPointerCancel={() => {
                draggingNoteRef.current = null;
              }}
              title={
                note.text
                  ? note.text.slice(0, 80)
                  : `Sticky note #${index + 1} (drag to move)`
              }
              className={`w-6 h-6 rounded-full border text-[11px] font-mono-num font-bold shadow-md flex items-center justify-center transition-transform hover:scale-110 cursor-grab active:cursor-grabbing ${theme.pin} ${
                isOpen ? 'ring-2 ring-stone-900 dark:ring-white scale-110' : ''
              }`}
            >
              {index + 1}
            </button>

            {/* Editable Sticky Note Popover */}
            {isOpen && (
              <div
                onClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
                className={`absolute w-64 rounded-md border shadow-xl p-3 space-y-2.5 z-30 ${theme.cardBg} ${theme.cardBorder} ${
                  flipLeft ? 'right-7' : 'left-7'
                } ${flipUp ? 'bottom-0' : 'top-0'}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <GripVertical className="w-3.5 h-3.5 text-stone-400" />
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-stone-600 dark:text-stone-300 font-mono-num">
                      Note #{index + 1}
                    </span>
                  </div>

                  {/* Color Swatches */}
                  <div className="flex items-center gap-1">
                    {(['amber', 'sage', 'sky', 'rose'] as const).map((c) => (
                      <button
                        key={c}
                        type="button"
                        aria-label={`Set note color ${NOTE_PALETTE[c].label}`}
                        onClick={() => onUpdateNote(note.id, { color: c })}
                        className={`w-3.5 h-3.5 rounded-full border cursor-pointer ${NOTE_PALETTE[c].pin} ${
                          note.color === c
                            ? 'ring-1 ring-offset-1 ring-stone-800 dark:ring-stone-200'
                            : 'opacity-70 hover:opacity-100'
                        }`}
                      />
                    ))}
                  </div>

                  <div className="flex items-center gap-0.5">
                    <button
                      type="button"
                      onClick={() => onDeleteNote(note.id)}
                      aria-label="Delete sticky note"
                      className="p-1 rounded text-stone-500 hover:text-red-700 dark:text-stone-400 dark:hover:text-red-400 cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onSelectNote(null)}
                      aria-label="Close sticky note"
                      className="p-1 rounded text-stone-500 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100 cursor-pointer"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                <textarea
                  autoFocus
                  rows={4}
                  value={note.text}
                  onChange={(e) => onUpdateNote(note.id, { text: e.target.value })}
                  placeholder="Write a quick technical reference, formula, or diagram note…"
                  className={`w-full text-xs leading-relaxed bg-transparent resize-y focus:outline-none placeholder:text-stone-400 dark:placeholder:text-stone-500 ${theme.text}`}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
