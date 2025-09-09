// Minimal vanilla JS CanvasKit raster app skeleton with tools

const state = {
    currentTool: 'pen',
    pen: {
        brushShape: 'ellipse', // 'ellipse' | 'rect'
        strokeWidth: 24,
        rotateAngle: 0,
        color: [0, 0, 0, 1],
        opacity: 1,
        brushWidth: 1.0, // scale factor relative to strokeWidth (1=100%)
        brushHeight: 1.0,
    },
    eraser: {
        brushShape: 'ellipse',
        strokeWidth: 24,
        rotateAngle: 0,
        opacity: 1,
        brushWidth: 1.0,
        brushHeight: 1.0,
    },
    shape: {
        type: 'line', // 'line' | 'rect' | 'ellipse'
        strokeWidth: 2,
        color: [0, 0, 0, 1],
    },
    selection: null, // { path: SkPath, points: [{x,y}], bounds: {x,y,w,h}, image: SkImage, offset:{x,y}, transform:{tx,ty,scale,rotation} }
};

// path smoothing
let invMass = 1.0;
// let damp = 0.05; // tweak this for level of smoothness
let nExtra = 4; // pre-smoothing by resampling more points
let curPos = [0, 0];
let curVel = [0, 0];
let curAcc = [0, 0];

const dom = {
    stage: document.getElementById('stage'),
    drawCanvas: document.getElementById('draw-canvas'),
    overlayCanvas: document.getElementById('overlay-canvas'),
    toolButtons: Array.from(document.querySelectorAll('.tool-btn[data-tool]')),
    penProps: document.getElementById('pen-props'),
    shapeProps: document.getElementById('shape-props'),
    brushShape: document.getElementById('brush-shape'),
    strokeWidth: document.getElementById('stroke-width'),
    strokeWidthVal: document.getElementById('stroke-width-val'),
    rotateAngle: document.getElementById('rotate-angle'),
    rotateAngleVal: document.getElementById('rotate-angle-val'),
    shapeType: document.getElementById('shape-type'),
    opacity: document.getElementById('opacity'),
    opacityVal: document.getElementById('opacity-val'),
    brushWidth: document.getElementById('brush-width'),
    brushWidthVal: document.getElementById('brush-width-val'),
    brushHeight: document.getElementById('brush-height'),
    brushHeightVal: document.getElementById('brush-height-val'),
};

// Add after DOM bindings
const shapeStrokeWidthEl = document.getElementById('shape-stroke-width');
const shapeStrokeWidthValEl = document.getElementById('shape-stroke-width-val');
if (shapeStrokeWidthEl && shapeStrokeWidthValEl) {
    shapeStrokeWidthEl.addEventListener('input', () => {
        const v = Number(shapeStrokeWidthEl.value || '2');
        state.shape.strokeWidth = v;
        shapeStrokeWidthValEl.textContent = String(v);
    });
}
// Initialize visibility on load
(function initShapeControls() {
    const g = document.getElementById('shape-stroke-width-group');
    if (g) g.hidden = state.shape.type !== 'line';
})();

// Smoothness binding (controls damp)
const smoothnessEl = document.getElementById('smoothness');
const smoothnessValEl = document.getElementById('smoothness-val');
if (smoothnessEl && smoothnessValEl) {
    smoothnessEl.addEventListener('input', () => {
        const v = Math.max(0.01, Math.min(0.1, Number(smoothnessEl.value)));
        smoothnessValEl.textContent = v.toFixed(3);
    });
}

// Load CanvasKit WASM
let CanvasKit = null;
let skSurface = null; // draw canvas surface
let overlaySurface = null; // overlay surface for previews and selection highlights
let skGrCtx = null; // GPU GrContext for draw canvas
let overlayGrCtx = null; // GPU GrContext for overlay canvas
let brushImage = null; // cached SkImage for pen brush
let eraserImage = null; // cached SkImage for eraser brush

function toSkColor(color4f) {
    // color4f is [r,g,b,a] in 0..1, convert to 0..255 ints
    const r = Math.max(0, Math.min(255, Math.round((color4f[0] || 0) * 255)));
    const g = Math.max(0, Math.min(255, Math.round((color4f[1] || 0) * 255)));
    const b = Math.max(0, Math.min(255, Math.round((color4f[2] || 0) * 255)));
    const a = Math.max(0, Math.min(255, Math.round((color4f[3] == null ? 1 : color4f[3]) * 255)));
    return CanvasKit.Color(r, g, b, a);
}

async function loadCanvasKit() {
    const candidate = { js: 'canvaskit/canvaskit.js', locate: file => `canvaskit/${file}` };
    await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = candidate.js;
        script.async = true;
        // classic script load; avoid crossorigin to prevent CORS block on some CDNs
        script.type = 'text/javascript';
        const onError = () => {
            cleanup();
            reject(new Error('Script load error'));
        };
        const onLoad = () => {
            if (!window.CanvasKitInit) {
                cleanup();
                reject(new Error('CanvasKitInit not found after script load'));
                return;
            }
            window
                .CanvasKitInit({ locateFile: candidate.locate })
                .then(ck => {
                    CanvasKit = ck;
                    cleanup();
                    resolve();
                })
                .catch(e => {
                    console.error('CanvasKitInit failed:', e);
                    cleanup();
                    reject(e);
                });
        };
        const timeoutId = setTimeout(() => {
            console.warn('CanvasKit load timeout:', candidate.js);
            cleanup();
            reject(new Error('Timeout loading CanvasKit'));
        }, 15000);
        function cleanup() {
            script.onload = null;
            script.onerror = null;
            clearTimeout(timeoutId);
        }
        script.onload = onLoad;
        script.onerror = onError;
        document.head.appendChild(script);
    });
}

function drawFilledLine(canvas, x0, y0, x1, y1, width, paint) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy) || 0.0001;
    const nx = -dy / len; // normal x
    const ny = dx / len; // normal y
    const hw = (width || 1) / 2;
    // Build a quad (rectangle) around the segment
    const path = new CanvasKit.Path();
    path.moveTo(x0 + nx * hw, y0 + ny * hw);
    path.lineTo(x0 - nx * hw, y0 - ny * hw);
    path.lineTo(x1 - nx * hw, y1 - ny * hw);
    path.lineTo(x1 + nx * hw, y1 + ny * hw);
    path.close();
    canvas.drawPath(path, paint);
    path.delete();
}

function setCanvasSize(canvas) {
    const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 3));
    const rect = dom.stage.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
}

function resizeSurfaces() {
    setCanvasSize(dom.drawCanvas);
    setCanvasSize(dom.overlayCanvas);
    if (!CanvasKit) return;
    // Dispose old GPU surfaces/contexts
    if (skSurface) {
        try {
            skSurface.dispose();
        } catch {}
        skSurface = null;
    }
    if (overlaySurface) {
        try {
            overlaySurface.dispose();
        } catch {}
        overlaySurface = null;
    }
    if (skGrCtx && skGrCtx.delete) {
        try {
            skGrCtx.delete();
        } catch {}
        skGrCtx = null;
    }
    if (overlayGrCtx && overlayGrCtx.delete) {
        try {
            overlayGrCtx.delete();
        } catch {}
        overlayGrCtx = null;
    }
    // Create GPU GL surfaces with preserveDrawingBuffer so stamps persist
    const main = makeGLSurface(dom.drawCanvas);
    const over = makeGLSurface(dom.overlayCanvas);
    if (!main || !over) {
        console.error('Failed to create GPU surfaces.');
        return;
    }
    skSurface = main.surface;
    skGrCtx = main.grCtx;
    overlaySurface = over.surface;
    overlayGrCtx = over.grCtx;
    clearOverlay();
}

function makeGLSurface(canvas) {
    try {
        const attrs = {
            antialias: true,
            alpha: true,
            depth: false,
            stencil: true,
            preserveDrawingBuffer: true,
            premultipliedAlpha: true,
            desynchronized: false,
        };
        const gl = CanvasKit.GetWebGLContext(canvas, attrs);
        if (!gl) return null;
        const grCtx = CanvasKit.MakeGrContext(gl);
        if (!grCtx) return null;
        const surface = CanvasKit.MakeOnScreenGLSurface(grCtx, canvas.width, canvas.height, CanvasKit.ColorSpace.SRGB);
        if (!surface) {
            try {
                grCtx.delete();
            } catch {}
            return null;
        }
        return { surface, grCtx };
    } catch (e) {
        console.error('makeGLSurface error', e);
        return null;
    }
}

function clearOverlay() {
    if (!overlaySurface) return;
    const c = overlaySurface.getCanvas();
    c.clear(CanvasKit.TRANSPARENT);
    overlaySurface.flush();
}

// Tool switching UI
function updateToolVisibility() {
    const showPen = state.currentTool === 'pen' || state.currentTool === 'eraser';
    const showShape = state.currentTool === 'shape';
    // Set both hidden attribute and inline display to avoid any CSS conflicts
    dom.penProps.hidden = !showPen;
    dom.penProps.style.display = showPen ? '' : 'none';
    dom.shapeProps.hidden = !showShape;
    dom.shapeProps.style.display = showShape ? '' : 'none';
    // Only show shape stroke width when shape type is line and Shape tool active
    const sg = document.getElementById('shape-stroke-width-group');
    if (sg) {
        const visible = showShape && state.shape.type === 'line';
        sg.hidden = !visible;
        sg.style.display = visible ? '' : 'none';
    }
    dom.toolButtons.forEach(btn => {
        btn.setAttribute('aria-pressed', String(btn.dataset.tool === state.currentTool));
    });
}

dom.toolButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        state.currentTool = btn.dataset.tool;
        updateToolVisibility();
        clearOverlay();
    });
});

// Clear canvas button
const clearBtn = document.getElementById('clear-btn');
if (clearBtn) {
    clearBtn.addEventListener('click', () => {
        if (!skSurface || !CanvasKit) return;
        const c = skSurface.getCanvas();
        c.clear(CanvasKit.TRANSPARENT);
        skSurface.flush();
        clearOverlay();
    });
}

// Pen props bindings
dom.brushShape.addEventListener('change', () => {
    state.pen.brushShape = dom.brushShape.value;
    state.eraser.brushShape = dom.brushShape.value;
    refreshBrushImages();
});
dom.strokeWidth.addEventListener('input', () => {
    const v = Number(dom.strokeWidth.value);
    state.pen.strokeWidth = v;
    state.eraser.strokeWidth = v;
    dom.strokeWidthVal.textContent = String(v);
    refreshBrushImages();
});
dom.rotateAngle.addEventListener('input', () => {
    const v = Number(dom.rotateAngle.value);
    state.pen.rotateAngle = v;
    state.eraser.rotateAngle = v;
    dom.rotateAngleVal.textContent = v + '°';
    refreshBrushImages();
});
dom.shapeType.addEventListener('change', () => {
    state.shape.type = dom.shapeType.value;
    const g = document.getElementById('shape-stroke-width-group');
    if (g) {
        const visible = state.shape.type === 'line' && state.currentTool === 'shape';
        g.hidden = !visible;
        g.style.display = visible ? '' : 'none';
    }
    updateToolVisibility();
});

// Opacity binding (0-100%)
dom.opacity.addEventListener('input', () => {
    const v = Math.max(10, Math.min(100, Number(dom.opacity.value)));
    state.pen.opacity = v / 1000; // compensate tight stamping overlapping
    state.eraser.opacity = v / 1000;
    dom.opacityVal.textContent = `${v}%`;
});

// Brush width/height scaling (10% - 400%)
dom.brushWidth.addEventListener('input', () => {
    const v = Math.max(10, Math.min(400, Number(dom.brushWidth.value)));
    state.pen.brushWidth = v / 100;
    state.eraser.brushWidth = v / 100;
    dom.brushWidthVal.textContent = `${v}%`;
    refreshBrushImages();
});
dom.brushHeight.addEventListener('input', () => {
    const v = Math.max(10, Math.min(400, Number(dom.brushHeight.value)));
    state.pen.brushHeight = v / 100;
    state.eraser.brushHeight = v / 100;
    dom.brushHeightVal.textContent = `${v}%`;
    refreshBrushImages();
});

// Pointer handling (mouse + touch unified)
let isPointerDown = false;
let lastPoint = null;
const activePointers = new Map(); // pointerId -> {x,y}

// return point is in pixel space considering dpi from event
function getStagePoint(evt) {
    const rect = dom.stage.getBoundingClientRect();
    const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 3));
    let clientX, clientY;
    if (evt.touches && evt.touches[0]) {
        clientX = evt.touches[0].clientX;
        clientY = evt.touches[0].clientY;
    } else {
        clientX = evt.clientX;
        clientY = evt.clientY;
    }
    return { x: (clientX - rect.left) * dpr, y: (clientY - rect.top) * dpr };
}

dom.stage.addEventListener('pointerdown', e => {
    isPointerDown = true;
    const p = getStagePoint(e);
    activePointers.set(e.pointerId, p);
    lastPoint = p;
    beginToolGesture(p, e.pointerId);
    // Prevent scrolling on mobile
    dom.stage.setPointerCapture(e.pointerId);
    e.preventDefault();
});

dom.stage.addEventListener('pointermove', e => {
    const p = getStagePoint(e);
    if (!isPointerDown) {
        previewMove(p);
        return;
    }
    activePointers.set(e.pointerId, p);
    drawToolStroke(p);
    lastPoint = p;
    e.preventDefault();
});

dom.stage.addEventListener('pointerup', e => {
    const p = getStagePoint(e);
    activePointers.delete(e.pointerId);
    isPointerDown = activePointers.size > 0;
    if (!isPointerDown) {
        finalizeToolGesture(p);
    }
    dom.stage.releasePointerCapture(e.pointerId);
    e.preventDefault();
});

dom.stage.addEventListener('pointerleave', () => {
    if (isPointerDown) {
        isPointerDown = false;
        finalizeToolGesture(lastPoint);
        activePointers.clear();
    }
});

// Keyboard shortcuts (desktop)
window.addEventListener('keydown', e => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
    if (e.key === '1') state.currentTool = 'pen';
    else if (e.key === '2') state.currentTool = 'shape';
    else if (e.key === '3') state.currentTool = 'eraser';
    else if (e.key === '4') state.currentTool = 'select';
    else if (e.key === '5') state.currentTool = 'transform';
    else if (e.key === '[') {
        const v = Math.max(1, state.pen.strokeWidth - 1);
        dom.strokeWidth.value = v;
        dom.strokeWidth.dispatchEvent(new Event('input'));
    } else if (e.key === ']') {
        const v = Math.min(200, state.pen.strokeWidth + 1);
        dom.strokeWidth.value = v;
        dom.strokeWidth.dispatchEvent(new Event('input'));
    } else if (e.key === ',') {
        const v = (state.pen.rotateAngle - 5 + 360) % 360;
        dom.rotateAngle.value = v;
        dom.rotateAngle.dispatchEvent(new Event('input'));
    } else if (e.key === '.') {
        const v = (state.pen.rotateAngle + 5) % 360;
        dom.rotateAngle.value = v;
        dom.rotateAngle.dispatchEvent(new Event('input'));
    } else if (e.key === 'Enter') {
        if (state.selection) {
            commitSelection();
        } else return;
    } else if (e.key === 'Escape') {
        if (state.selection) {
            cancelSelection();
        } else return;
    } else return;
    updateToolVisibility();
    clearOverlay();
});

// Tool gesture helpers
let gesture = null; // stores per-gesture temp data

function beginToolGesture(p, pointerId) {
    if (!CanvasKit || !skSurface) return;
    gesture = { start: p, last: p, pointerId, points: [p] };
    if (state.currentTool === 'shape') {
        clearOverlay();
    } else if (state.currentTool === 'select') {
        // start lasso
        clearOverlay();
        gesture.points = [p];
    } else if (state.currentTool === 'pen' || state.currentTool === 'eraser') {
        // Stamp initial brush immediately on down
        const paint = new CanvasKit.Paint();
        paint.setAntiAlias(true);
        paint.setBlendMode(state.currentTool === 'eraser' ? CanvasKit.BlendMode.DstOut : CanvasKit.BlendMode.SrcOver);
        paint.setColor(CanvasKit.Color(0, 0, 0, 255));
        paint.setAlphaf(state.pen.opacity);
        paint.setStyle(CanvasKit.PaintStyle.Fill);
        const c = skSurface.getCanvas();

        // init smoothing state
        curPos = [p.x, p.y];
        curVel = [0, 0];
        curAcc = [0, 0];

        stampBrushBlit(c, paint, p.x, p.y, state.currentTool === 'eraser');
        paint.delete();
        skSurface.flush();
        // Hide any hover outline while drawing
        clearOverlay();
    }
}

function drawToolStroke(p) {
    if (!CanvasKit || !skSurface) return;
    if (state.currentTool === 'pen' || state.currentTool === 'eraser') {
        // Stamp oriented brush between last and p
        // Ensure hover outline is hidden during drawing
        clearOverlay();
        const paint = new CanvasKit.Paint();
        paint.setAntiAlias(true);
        paint.setBlendMode(state.currentTool === 'eraser' ? CanvasKit.BlendMode.DstOut : CanvasKit.BlendMode.SrcOver);
        paint.setColor(CanvasKit.Color(0, 0, 0, 255));
        paint.setAlphaf(state.pen.opacity);
        paint.setStyle(CanvasKit.PaintStyle.Fill);
        const canvas = skSurface.getCanvas();

        // smoothing
        const damp = Number(smoothnessValEl.textContent);
        let target = [p.x, p.y];
        let totalAcc = [(target[0] - curPos[0]) * invMass, (target[1] - curPos[1]) * invMass];
        let targetVel = [(curVel[0] + totalAcc[0]) * damp, (curVel[1] + totalAcc[1]) * damp];

        // amortized acc
        let deltaAcc = [0, 0];
        for (let k = 0; k < 2; k++) {
            deltaAcc[k] = ((targetVel[k] - curVel[k] - nExtra * curAcc[k]) * 2) / (nExtra * (nExtra + 1));
        }

        // add extra points using forward Euler integrator (not unconditionally stable)
        const points = [{ x: curPos[0], y: curPos[1] }];
        for (let i = 0; i < nExtra; i++) {
            for (let k = 0; k < 2; k++) {
                curAcc[k] += deltaAcc[k];
                curVel[k] += curAcc[k];
                curPos[k] += curVel[k];
            }
            points.push({ x: curPos[0], y: curPos[1] });
        }

        // now stamping points segment by segment
        for (let i = 0; i < points.length - 1; i++) {
            const p0 = points[i];
            const p1 = points[i + 1];

            const dx = p1.x - p0.x;
            const dy = p1.y - p0.y;
            const dist = Math.hypot(dx, dy) || 0.0001;
            const base = state.pen.strokeWidth / 2;
            const rx = base * (state.pen.brushWidth || 1);
            const ry = base * (state.pen.brushHeight || 1);
            const step = Math.min(0.2, Math.min(rx, ry));
            const steps = Math.ceil(dist / step);
            for (let k = 1; k <= steps; k++) {
                const t = k / steps;
                const x = p0.x + dx * t;
                const y = p0.y + dy * t;
                stampBrushBlit(canvas, paint, x, y, state.currentTool === 'eraser');
            }
        }

        paint.delete();
        skSurface.flush();
        gesture.last = p;
    } else if (state.currentTool === 'shape') {
        // draw filled preview on overlay
        const c = overlaySurface.getCanvas();
        c.clear(CanvasKit.TRANSPARENT);
        const paint = new CanvasKit.Paint();
        paint.setAntiAlias(true);
        paint.setColor(CanvasKit.Color(0, 0, 0, 1));
        paint.setStyle(CanvasKit.PaintStyle.Fill);
        const { x: x0, y: y0 } = gesture.start;
        const { x: x1, y: y1 } = p;
        if (state.shape.type === 'line') {
            drawFilledLine(c, x0, y0, x1, y1, state.shape.strokeWidth, paint);
        } else if (state.shape.type === 'rect') {
            const l = Math.min(x0, x1),
                r = Math.max(x0, x1);
            const t = Math.min(y0, y1),
                b = Math.max(y0, y1);
            c.drawRect(CanvasKit.XYWHRect(l, t, r - l, b - t), paint);
        } else if (state.shape.type === 'ellipse') {
            const cx = (x0 + x1) / 2;
            const cy = (y0 + y1) / 2;
            const rx = Math.abs(x1 - x0) / 2;
            const ry = Math.abs(y1 - y0) / 2;
            c.drawOval(CanvasKit.XYWHRect(cx - rx, cy - ry, rx * 2, ry * 2), paint);
        }
        paint.delete();
        overlaySurface.flush();
    } else if (state.currentTool === 'select') {
        // append to lasso path and preview
        const last = gesture.points[gesture.points.length - 1];
        const dx = p.x - last.x,
            dy = p.y - last.y;
        if (dx * dx + dy * dy > 4) {
            // add point if moved > 2px
            gesture.points.push(p);
        }
        previewLasso(gesture.points);
    } else if (state.currentTool === 'transform' && state.selection) {
        // update transform from active pointers
        updateTransformFromPointers();
        drawSelectionOverlay(true);
    }
}

function finalizeToolGesture(p) {
    if (!CanvasKit || !skSurface) return;
    if (state.currentTool === 'shape') {
        // commit filled shape to draw canvas
        const canvas = skSurface.getCanvas();
        const paint = new CanvasKit.Paint();
        paint.setAntiAlias(true);
        paint.setColor(CanvasKit.Color(0, 0, 0, 1));
        paint.setStyle(CanvasKit.PaintStyle.Fill);
        const { x: x0, y: y0 } = gesture.start;
        const { x: x1, y: y1 } = p;
        if (state.shape.type === 'line') {
            drawFilledLine(canvas, x0, y0, x1, y1, state.shape.strokeWidth, paint);
        } else if (state.shape.type === 'rect') {
            const l = Math.min(x0, x1),
                r = Math.max(x0, x1);
            const t = Math.min(y0, y1),
                b = Math.max(y0, y1);
            canvas.drawRect(CanvasKit.XYWHRect(l, t, r - l, b - t), paint);
        } else if (state.shape.type === 'ellipse') {
            const cx = (x0 + x1) / 2;
            const cy = (y0 + y1) / 2;
            const rx = Math.abs(x1 - x0) / 2;
            const ry = Math.abs(y1 - y0) / 2;
            canvas.drawOval(CanvasKit.XYWHRect(cx - rx, cy - ry, rx * 2, ry * 2), paint);
        }
        paint.delete();
        skSurface.flush();
        clearOverlay();
    } else if (state.currentTool === 'select') {
        finalizeLassoSelection(gesture.points);
    }

    gesture = null;
}

function stampBrush(canvas, paint, x, y) {
    const size = state.pen.strokeWidth;
    const hw = size / 2;
    const angleDeg = state.pen.rotateAngle || 0;
    const rx = hw * (state.pen.brushWidth || 1);
    const ry = hw * (state.pen.brushHeight || 1);
    const save = canvas.save();
    canvas.translate(x, y);
    canvas.rotate(angleDeg, 0, 0);
    if (state.pen.brushShape === 'ellipse') {
        canvas.drawOval(CanvasKit.XYWHRect(-rx, -ry, rx * 2, ry * 2), paint);
    } else {
        canvas.drawRect(CanvasKit.XYWHRect(-rx, -ry, rx * 2, ry * 2), paint);
    }
    canvas.restoreToCount(save);
}

function stampBrushBlit(canvas, paint, x, y, isErasing) {
    const img = isErasing ? eraserImage || brushImage : brushImage;
    if (img) {
        const w = img.width();
        const h = img.height();
        const save = canvas.save();
        const angleDeg = state.pen.rotateAngle || 0;
        canvas.translate(x, y);
        canvas.rotate(angleDeg, 0, 0);
        canvas.translate(-w / 2, -h / 2);
        canvas.drawImage(img, 0, 0, paint);
        canvas.restoreToCount(save);
        return;
    }
    // Fallback to vector stamp
    stampBrush(canvas, paint, x, y);
}

function drawBrushOutline(x, y) {
    if (!overlaySurface) return;
    const c = overlaySurface.getCanvas();
    c.clear(CanvasKit.TRANSPARENT);
    // Outer white stroke
    const paintOuter = new CanvasKit.Paint();
    paintOuter.setAntiAlias(true);
    paintOuter.setStyle(CanvasKit.PaintStyle.Stroke);
    paintOuter.setStrokeWidth(2);
    paintOuter.setColor(CanvasKit.Color(255, 255, 255, 255));
    // Inner black stroke
    const paintInner = new CanvasKit.Paint();
    paintInner.setAntiAlias(true);
    paintInner.setStyle(CanvasKit.PaintStyle.Stroke);
    paintInner.setStrokeWidth(1);
    paintInner.setColor(CanvasKit.Color(0, 0, 0, 255));
    const size = state.pen.strokeWidth;
    const hw = size / 2;
    const rx = hw * (state.pen.brushWidth || 1);
    const ry = hw * (state.pen.brushHeight || 1);
    const angleDeg = state.pen.rotateAngle || 0;
    const save = c.save();
    c.translate(x, y);
    c.rotate(angleDeg, 0, 0);
    if (state.pen.brushShape === 'ellipse') {
        const rect = CanvasKit.XYWHRect(-rx, -ry, rx * 2, ry * 2);
        c.drawOval(rect, paintOuter);
        c.drawOval(rect, paintInner);
    } else {
        const rect = CanvasKit.XYWHRect(-rx, -ry, rx * 2, ry * 2);
        c.drawRect(rect, paintOuter);
        c.drawRect(rect, paintInner);
    }
    c.restoreToCount(save);
    paintOuter.delete();
    paintInner.delete();
    overlaySurface.flush();
}

async function main() {
    await loadCanvasKit();
    resizeSurfaces();
    updateToolVisibility();
    refreshBrushImages();
    window.addEventListener('resize', resizeSurfaces, { passive: true });
}

main().catch(e => console.error(e));

// ---------- Selection & Transform ----------

function previewMove(p) {
    if (!CanvasKit || !overlaySurface) return;
    if (state.currentTool === 'pen' || state.currentTool === 'eraser') {
        drawBrushOutline(p.x, p.y);
    } else if (state.currentTool === 'transform' && state.selection) {
        drawSelectionOverlay(true);
    } else {
        clearOverlay();
    }
}

function previewLasso(points) {
    if (!overlaySurface || !CanvasKit) return;
    const c = overlaySurface.getCanvas();
    c.clear(CanvasKit.TRANSPARENT);
    const path = new CanvasKit.Path();
    if (points.length) {
        path.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) path.lineTo(points[i].x, points[i].y);
    }
    const fillPaint = new CanvasKit.Paint();
    fillPaint.setAntiAlias(true);
    fillPaint.setColor(CanvasKit.Color4f(0.1, 0.5, 1.0, 0.15));
    c.drawPath(path, fillPaint);
    fillPaint.delete();
    const stroke = new CanvasKit.Paint();
    stroke.setAntiAlias(true);
    stroke.setStyle(CanvasKit.PaintStyle.Stroke);
    stroke.setColor(CanvasKit.Color4f(0.1, 0.5, 1.0, 1));
    stroke.setStrokeWidth(2);
    const dash = CanvasKit.PathEffect.MakeDash([8, 6], (performance.now() / 40) % 14);
    stroke.setPathEffect(dash);
    c.drawPath(path, stroke);
    stroke.delete();
    overlaySurface.flush();
    path.delete();
}

function finalizeLassoSelection(points) {
    if (!points || points.length < 3) {
        clearOverlay();
        return;
    }
    // Build SkPath
    const path = new CanvasKit.Path();
    path.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) path.lineTo(points[i].x, points[i].y);
    path.close();
    const bounds = path.getBounds();
    const bx = Math.floor(bounds.fLeft),
        by = Math.floor(bounds.fTop);
    const bw = Math.max(1, Math.ceil(bounds.fRight - bx));
    const bh = Math.max(1, Math.ceil(bounds.fBottom - by));
    // Create an offscreen surface and clip to selection, then draw base snapshot into it
    const offscreen = CanvasKit.MakeSurface(bw, bh);
    if (!offscreen) {
        path.delete();
        return;
    }
    const oc = offscreen.getCanvas();
    oc.clear(CanvasKit.TRANSPARENT);
    oc.save();
    // Align world path to offscreen by translating
    oc.translate(-bx, -by);
    oc.clipPath(path, CanvasKit.ClipOp.Intersect, true);
    const fullImage = skSurface.makeImageSnapshot();
    const src = CanvasKit.XYWHRect(bx, by, bw, bh);
    const dst = CanvasKit.XYWHRect(0, 0, bw, bh);
    oc.drawImageRect(fullImage, src, dst, null);
    oc.restore();
    const selImage = offscreen.makeImageSnapshot();
    // Clear selection area from base canvas
    const baseCanvas = skSurface.getCanvas();
    const clearPaint = new CanvasKit.Paint();
    clearPaint.setAntiAlias(true);
    clearPaint.setBlendMode(CanvasKit.BlendMode.Clear);
    baseCanvas.drawPath(path, clearPaint);
    clearPaint.delete();
    skSurface.flush();
    // Dispose temps
    fullImage.delete();
    offscreen.dispose();
    // Save selection state
    state.selection = {
        path,
        points: points.slice(),
        bounds: { x: bx, y: by, w: bw, h: bh },
        image: selImage,
        offset: { x: bx, y: by },
        transform: { tx: 0, ty: 0, scale: 1, rotation: 0 },
    };
    // Show overlay with floating image
    drawSelectionOverlay(true);
}

function drawSelectionOverlay(showImage) {
    if (!state.selection || !overlaySurface) return;
    const c = overlaySurface.getCanvas();
    c.clear(CanvasKit.TRANSPARENT);
    // Draw floating image with transform
    if (showImage) {
        const { image, bounds, offset, transform } = state.selection;
        const save = c.save();
        c.translate(offset.x + transform.tx + bounds.w / 2, offset.y + transform.ty + bounds.h / 2);
        const rotDeg = ((transform.rotation || 0) * 180) / Math.PI;
        c.rotate(rotDeg, 0, 0);
        c.scale(transform.scale || 1, transform.scale || 1);
        c.translate(-bounds.w / 2, -bounds.h / 2);
        c.drawImage(image, 0, 0);
        c.restoreToCount(save);
    }
    // Draw selection outline (animated dash)
    const stroke = new CanvasKit.Paint();
    stroke.setAntiAlias(true);
    stroke.setStyle(CanvasKit.PaintStyle.Stroke);
    stroke.setColor(CanvasKit.Color4f(0.1, 0.5, 1.0, 1));
    stroke.setStrokeWidth(2);
    const dash = CanvasKit.PathEffect.MakeDash([8, 6], (performance.now() / 40) % 14);
    stroke.setPathEffect(dash);
    const { path, bounds, transform } = state.selection;
    const cx = bounds.x + bounds.w / 2;
    const cy = bounds.y + bounds.h / 2;
    c.save();
    c.translate(transform.tx, transform.ty);
    c.translate(cx, cy);
    const outlineRotDeg = ((transform.rotation || 0) * 180) / Math.PI;
    c.rotate(outlineRotDeg, 0, 0);
    c.scale(transform.scale || 1, transform.scale || 1);
    c.translate(-cx, -cy);
    c.drawPath(path, stroke);
    c.restore();
    dash.delete();
    stroke.delete();
    overlaySurface.flush();
}

function updateTransformFromPointers() {
    if (!state.selection) return;
    const pts = Array.from(activePointers.values());
    if (pts.length === 0) return;
    const sel = state.selection;
    if (!gesture || !gesture.transformStart) {
        gesture = gesture || {};
        gesture.transformStart = {
            transform: { ...sel.transform },
            pointers: pts.map(p => ({ ...p })),
            centroid: centroidOf(pts),
            seedAngle: pts.length >= 2 ? Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x) : 0,
            seedDist: pts.length >= 2 ? distance(pts[0], pts[1]) : 1,
        };
    }
    const start = gesture.transformStart;
    const curCentroid = centroidOf(pts);
    const dtx = curCentroid.x - start.centroid.x;
    const dty = curCentroid.y - start.centroid.y;
    let scale = start.transform.scale;
    let rot = start.transform.rotation;
    if (pts.length >= 2 && start.pointers.length >= 2) {
        const curAngle = Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x);
        const curDist = distance(pts[0], pts[1]);
        const ds = curDist / (start.seedDist || 1);
        scale = Math.max(0.05, Math.min(8, start.transform.scale * ds));
        rot = start.transform.rotation + (curAngle - start.seedAngle);
    }
    sel.transform = { tx: start.transform.tx + dtx, ty: start.transform.ty + dty, scale, rotation: rot };
}

function centroidOf(arr) {
    let sx = 0,
        sy = 0;
    for (const p of arr) {
        sx += p.x;
        sy += p.y;
    }
    return { x: sx / arr.length, y: sy / arr.length };
}
function distance(a, b) {
    const dx = a.x - b.x,
        dy = a.y - b.y;
    return Math.hypot(dx, dy);
}

function commitSelection() {
    if (!state.selection) return;
    const { image, bounds, offset, transform } = state.selection;
    const c = skSurface.getCanvas();
    const save = c.save();
    c.translate(offset.x + transform.tx + bounds.w / 2, offset.y + transform.ty + bounds.h / 2);
    c.rotate(transform.rotation || 0);
    c.scale(transform.scale || 1, transform.scale || 1);
    c.translate(-bounds.w / 2, -bounds.h / 2);
    c.drawImage(image, 0, 0);
    c.restoreToCount(save);
    skSurface.flush();
    disposeSelection();
    clearOverlay();
}

function cancelSelection() {
    if (!state.selection) return;
    const { image, bounds, offset } = state.selection;
    const c = skSurface.getCanvas();
    const save = c.save();
    c.translate(offset.x, offset.y);
    c.drawImage(image, 0, 0);
    c.restoreToCount(save);
    skSurface.flush();
    disposeSelection();
    clearOverlay();
}

function disposeSelection() {
    if (!state.selection) return;
    try {
        state.selection.image.delete();
    } catch {}
    try {
        state.selection.path.delete();
    } catch {}
    state.selection = null;
    gesture = null;
}

function refreshBrushImages() {
    if (!CanvasKit) return;
    try {
        if (brushImage) brushImage.delete();
    } catch {}
    try {
        if (eraserImage) eraserImage.delete();
    } catch {}
    brushImage = null;
    eraserImage = null;
    const base = state.pen.strokeWidth / 2;
    const rx = Math.max(0.5, base * (state.pen.brushWidth || 1));
    const ry = Math.max(0.5, base * (state.pen.brushHeight || 1));
    const w = Math.max(1, Math.ceil(rx * 2));
    const h = Math.max(1, Math.ceil(ry * 2));
    const surf = CanvasKit.MakeSurface(w, h);
    if (!surf) return;
    const c = surf.getCanvas();
    c.clear(CanvasKit.TRANSPARENT);
    const p = new CanvasKit.Paint();
    p.setAntiAlias(true);
    p.setStyle(CanvasKit.PaintStyle.Fill);
    p.setColor(CanvasKit.Color(0, 0, 0, 255));
    const save = c.save();
    c.translate(w / 2, h / 2);
    if (state.pen.brushShape === 'ellipse') {
        c.drawOval(CanvasKit.XYWHRect(-rx, -ry, rx * 2, ry * 2), p);
    } else {
        c.drawRect(CanvasKit.XYWHRect(-rx, -ry, rx * 2, ry * 2), p);
    }
    c.restoreToCount(save);
    brushImage = surf.makeImageSnapshot();
    eraserImage = brushImage;
    p.delete();
    surf.dispose();
}
