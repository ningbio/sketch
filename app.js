// Minimal vanilla JS CanvasKit raster app skeleton with tools

const state = {
	currentTool: 'pen',
	pen: {
		brushShape: 'ellipse', // 'ellipse' | 'rect'
		strokeWidth: 24,
		rotateAngle: 0,
		color: [0, 0, 0, 1],
		opacity: 1,
	},
	eraser: {
		brushShape: 'ellipse',
		strokeWidth: 24,
		rotateAngle: 0,
		opacity: 1,
	},
	shape: {
		type: 'line', // 'line' | 'rect' | 'ellipse'
		strokeWidth: 2,
		color: [0, 0, 0, 1],
	},
	selection: null, // { path: SkPath, points: [{x,y}], bounds: {x,y,w,h}, image: SkImage, offset:{x,y}, transform:{tx,ty,scale,rotation} }
};

const dom = {
	stage: document.getElementById('stage'),
	drawCanvas: document.getElementById('draw-canvas'),
	overlayCanvas: document.getElementById('overlay-canvas'),
	toolButtons: Array.from(document.querySelectorAll('.tool-btn')),
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
};

// Load CanvasKit WASM
let CanvasKit = null;
let skSurface = null; // draw canvas surface
let overlaySurface = null; // overlay surface for previews and selection highlights

function toSkColor(color4f) {
	// color4f is [r,g,b,a] in 0..1, convert to 0..255 ints
	const r = Math.max(0, Math.min(255, Math.round((color4f[0] || 0) * 255)));
	const g = Math.max(0, Math.min(255, Math.round((color4f[1] || 0) * 255)));
	const b = Math.max(0, Math.min(255, Math.round((color4f[2] || 0) * 255)));
	const a = Math.max(0, Math.min(255, Math.round((color4f[3] == null ? 1 : color4f[3]) * 255)));
	return CanvasKit.Color(r, g, b, a);
}

async function loadCanvasKit() {
	const candidate = { js: '/canvaskit/canvaskit.js', locate: (file) => `/canvaskit/${file}` };
	try {
		await loadFrom(candidate);
	} catch (e) {
		console.error('CanvasKit load failed:', candidate.js, e);
		throw e;
	}
}

function loadFrom(candidate) {
	return new Promise((resolve, reject) => {
		const script = document.createElement('script');
		script.src = candidate.js;
		script.async = true;
		// classic script load; avoid crossorigin to prevent CORS block on some CDNs
		script.type = 'text/javascript';
		const onError = (e) => {
			cleanup();
			reject(new Error('Script load error'));
		};
		const onLoad = () => {
			if (!window.CanvasKitInit) {
				cleanup();
				reject(new Error('CanvasKitInit not found after script load'));
				return;
			}
			window.CanvasKitInit({ locateFile: candidate.locate })
				.then((ck) => { CanvasKit = ck; cleanup(); resolve(); })
				.catch((e) => { console.error('CanvasKitInit failed:', e); cleanup(); reject(e); });
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
	if (skSurface) skSurface.dispose();
	if (overlaySurface) overlaySurface.dispose();
	// Try GPU surface, fallback to software surface if needed
	skSurface = CanvasKit.MakeCanvasSurface(dom.drawCanvas) || CanvasKit.MakeSWCanvasSurface(dom.drawCanvas);
	overlaySurface = CanvasKit.MakeCanvasSurface(dom.overlayCanvas) || CanvasKit.MakeSWCanvasSurface(dom.overlayCanvas);
	if (!skSurface || !overlaySurface) {
		console.error('Failed to create CanvasKit surface(s).');
		return;
	}
	clearOverlay();
}

function clearOverlay() {
	if (!overlaySurface) return;
	const c = overlaySurface.getCanvas();
	c.clear(CanvasKit.TRANSPARENT);
	overlaySurface.flush();
}

// Tool switching UI
function updateToolVisibility() {
	dom.penProps.hidden = state.currentTool !== 'pen' && state.currentTool !== 'eraser';
	dom.shapeProps.hidden = state.currentTool !== 'shape';
	dom.toolButtons.forEach((btn) => {
		btn.setAttribute('aria-pressed', String(btn.dataset.tool === state.currentTool));
	});
}

dom.toolButtons.forEach((btn) => {
	btn.addEventListener('click', () => {
		state.currentTool = btn.dataset.tool;
		updateToolVisibility();
		clearOverlay();
	});
});

// Pen props bindings
dom.brushShape.addEventListener('change', () => {
	state.pen.brushShape = dom.brushShape.value;
	state.eraser.brushShape = dom.brushShape.value;
});
dom.strokeWidth.addEventListener('input', () => {
	const v = Number(dom.strokeWidth.value);
	state.pen.strokeWidth = v; state.eraser.strokeWidth = v;
	dom.strokeWidthVal.textContent = String(v);
});
dom.rotateAngle.addEventListener('input', () => {
	const v = Number(dom.rotateAngle.value);
	state.pen.rotateAngle = v; state.eraser.rotateAngle = v;
	dom.rotateAngleVal.textContent = v + '°';
});
dom.shapeType.addEventListener('change', () => {
	state.shape.type = dom.shapeType.value;
});

// Opacity binding (0-100%)
dom.opacity.addEventListener('input', () => {
	const v = Math.max(0, Math.min(100, Number(dom.opacity.value)));
	state.pen.opacity = v / 100;
	state.eraser.opacity = v / 100;
	dom.opacityVal.textContent = `${v}%`;
});

// Pointer handling (mouse + touch unified)
let isPointerDown = false;
let lastPoint = null;
const activePointers = new Map(); // pointerId -> {x,y}

function getStagePoint(evt) {
	const rect = dom.stage.getBoundingClientRect();
	const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 3));
	let clientX, clientY;
	if (evt.touches && evt.touches[0]) { clientX = evt.touches[0].clientX; clientY = evt.touches[0].clientY; }
	else { clientX = evt.clientX; clientY = evt.clientY; }
	return { x: (clientX - rect.left) * dpr, y: (clientY - rect.top) * dpr };
}

dom.stage.addEventListener('pointerdown', (e) => {
	isPointerDown = true;
	const p = getStagePoint(e);
	activePointers.set(e.pointerId, p);
	lastPoint = p;
	beginToolGesture(p, e.pointerId);
	// Prevent scrolling on mobile
	dom.stage.setPointerCapture(e.pointerId);
	e.preventDefault();
});

dom.stage.addEventListener('pointermove', (e) => {
	const p = getStagePoint(e);
	if (!isPointerDown) { previewMove(p); return; }
	activePointers.set(e.pointerId, p);
	drawToolStroke(p, e.pointerId);
	lastPoint = p;
	e.preventDefault();
});

dom.stage.addEventListener('pointerup', (e) => {
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
	if (isPointerDown) { isPointerDown = false; finalizeToolGesture(lastPoint); activePointers.clear(); }
});

// Keyboard shortcuts (desktop)
window.addEventListener('keydown', (e) => {
	if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
	if (e.key === '1') state.currentTool = 'pen';
	else if (e.key === '2') state.currentTool = 'shape';
	else if (e.key === '3') state.currentTool = 'eraser';
	else if (e.key === '4') state.currentTool = 'select';
	else if (e.key === '5') state.currentTool = 'transform';
	else if (e.key === '[') { const v = Math.max(1, state.pen.strokeWidth - 1); dom.strokeWidth.value = v; dom.strokeWidth.dispatchEvent(new Event('input')); }
	else if (e.key === ']') { const v = Math.min(200, state.pen.strokeWidth + 1); dom.strokeWidth.value = v; dom.strokeWidth.dispatchEvent(new Event('input')); }
	else if (e.key === ',') { const v = (state.pen.rotateAngle - 5 + 360) % 360; dom.rotateAngle.value = v; dom.rotateAngle.dispatchEvent(new Event('input')); }
	else if (e.key === '.') { const v = (state.pen.rotateAngle + 5) % 360; dom.rotateAngle.value = v; dom.rotateAngle.dispatchEvent(new Event('input')); }
	else if (e.key === 'Enter') { if (state.selection) { commitSelection(); } else return; }
	else if (e.key === 'Escape') { if (state.selection) { cancelSelection(); } else return; }
	else return;
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
		// Initialize stroke path (Ink-style continuous stroke)
		gesture.strokePath = new CanvasKit.Path();
		gesture.strokePath.moveTo(p.x, p.y);
		// Draw a tiny segment to place an initial dot
		const paint = new CanvasKit.Paint();
		paint.setAntiAlias(true);
		paint.setBlendMode(state.currentTool === 'eraser' ? CanvasKit.BlendMode.Clear : CanvasKit.BlendMode.SrcOver);
		paint.setColor(CanvasKit.Color(0, 0, 0, Math.round((state.pen.opacity ?? 1) * 255)));
		paint.setStyle(CanvasKit.PaintStyle.Stroke);
		paint.setStrokeWidth(state.pen.strokeWidth);
		paint.setStrokeCap(CanvasKit.StrokeCap.Round);
		paint.setStrokeJoin(CanvasKit.StrokeJoin.Round);
		const c = skSurface.getCanvas();
		gesture.strokePath.lineTo(p.x + 0.01, p.y + 0.01);
		c.drawPath(gesture.strokePath, paint);
		paint.delete();
		skSurface.flush();
	}
}

function drawToolStroke(p, pointerId) {
	if (!CanvasKit || !skSurface) return;
	if (state.currentTool === 'pen' || state.currentTool === 'eraser') {
		// Extend and draw the stroke path continuously
		const paint = new CanvasKit.Paint();
		paint.setAntiAlias(true);
		paint.setBlendMode(state.currentTool === 'eraser' ? CanvasKit.BlendMode.Clear : CanvasKit.BlendMode.SrcOver);
		paint.setColor(CanvasKit.Color(0, 0, 0, Math.round((state.pen.opacity ?? 1) * 255)));
		paint.setStyle(CanvasKit.PaintStyle.Stroke);
		paint.setStrokeWidth(state.pen.strokeWidth);
		paint.setStrokeCap(CanvasKit.StrokeCap.Round);
		paint.setStrokeJoin(CanvasKit.StrokeJoin.Round);
		gesture.strokePath.lineTo(p.x, p.y);
		const c = skSurface.getCanvas();
		c.drawPath(gesture.strokePath, paint);
		paint.delete();
		skSurface.flush();
		gesture.last = p;
	} else if (state.currentTool === 'shape') {
		// draw preview on overlay
		const c = overlaySurface.getCanvas();
		c.clear(CanvasKit.TRANSPARENT);
		const paint = new CanvasKit.Paint();
		paint.setAntiAlias(true);
		paint.setColor(CanvasKit.Color4f(0, 0, 0, 1));
		paint.setStyle(CanvasKit.PaintStyle.Stroke);
		paint.setStrokeWidth(state.shape.strokeWidth);
		const { x: x0, y: y0 } = gesture.start;
		const { x: x1, y: y1 } = p;
		if (state.shape.type === 'line') {
			c.drawLine(x0, y0, x1, y1, paint);
		} else if (state.shape.type === 'rect') {
			const l = Math.min(x0, x1), r = Math.max(x0, x1);
			const t = Math.min(y0, y1), b = Math.max(y0, y1);
			c.drawRect(CanvasKit.XYWHRect(l, t, r - l, b - t), paint);
		} else if (state.shape.type === 'ellipse') {
			const cx = (x0 + x1) / 2; const cy = (y0 + y1) / 2;
			const rx = Math.abs(x1 - x0) / 2; const ry = Math.abs(y1 - y0) / 2;
			c.drawOval(CanvasKit.XYWHRect(cx - rx, cy - ry, rx * 2, ry * 2), paint);
		}
		paint.delete();
		overlaySurface.flush();
	} else if (state.currentTool === 'select') {
		// append to lasso path and preview
		const last = gesture.points[gesture.points.length - 1];
		const dx = p.x - last.x, dy = p.y - last.y;
		if (dx * dx + dy * dy > 4) { // add point if moved > 2px
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
		// commit preview to draw canvas
		const canvas = skSurface.getCanvas();
		const paint = new CanvasKit.Paint();
		paint.setAntiAlias(true);
		paint.setColor(CanvasKit.Color(0, 0, 0, 255));
		paint.setStyle(CanvasKit.PaintStyle.Stroke);
		paint.setStrokeWidth(state.shape.strokeWidth);
		const { x: x0, y: y0 } = gesture.start;
		const { x: x1, y: y1 } = p;
		if (state.shape.type === 'line') {
			canvas.drawLine(x0, y0, x1, y1, paint);
		} else if (state.shape.type === 'rect') {
			const l = Math.min(x0, x1), r = Math.max(x0, x1);
			const t = Math.min(y0, y1), b = Math.max(y0, y1);
			canvas.drawRect(CanvasKit.XYWHRect(l, t, r - l, b - t), paint);
		} else if (state.shape.type === 'ellipse') {
			const cx = (x0 + x1) / 2; const cy = (y0 + y1) / 2;
			const rx = Math.abs(x1 - x0) / 2; const ry = Math.abs(y1 - y0) / 2;
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

function stampBrush(canvas, paint, x, y, isErasing) {
	const size = state.pen.strokeWidth;
	const hw = size / 2;
	const angleDeg = (state.pen.rotateAngle || 0);
	const rx = hw;
	const ry = hw * (state.pen.brushShape === 'ellipse' ? 0.7 : 1);
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

async function main() {
	await loadCanvasKit();
	resizeSurfaces();
	updateToolVisibility();
	window.addEventListener('resize', resizeSurfaces, { passive: true });
}

main().catch((e) => console.error(e));

// ---------- Selection & Transform ----------

function previewMove(p) {
	// Optionally render brush outline or hover effects; keep minimal
	if (state.currentTool === 'transform' && state.selection) {
		drawSelectionOverlay(true);
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
	if (!points || points.length < 3) { clearOverlay(); return; }
	// Build SkPath
	const path = new CanvasKit.Path();
	path.moveTo(points[0].x, points[0].y);
	for (let i = 1; i < points.length; i++) path.lineTo(points[i].x, points[i].y);
	path.close();
	const bounds = path.getBounds();
	const bx = Math.floor(bounds.fLeft), by = Math.floor(bounds.fTop);
	const bw = Math.max(1, Math.ceil(bounds.fRight - bx));
	const bh = Math.max(1, Math.ceil(bounds.fBottom - by));
	// Create an offscreen surface and clip to selection, then draw base snapshot into it
	const offscreen = CanvasKit.MakeSurface(bw, bh);
	if (!offscreen) { path.delete(); return; }
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
		transform: { tx: 0, ty: 0, scale: 1, rotation: 0 }
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
	let sx = 0, sy = 0; for (const p of arr) { sx += p.x; sy += p.y; }
	return { x: sx / arr.length, y: sy / arr.length };
}
function distance(a, b) { const dx = a.x - b.x, dy = a.y - b.y; return Math.hypot(dx, dy); }

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
	try { state.selection.image.delete(); } catch {}
	try { state.selection.path.delete(); } catch {}
	state.selection = null;
	gesture = null;
}


