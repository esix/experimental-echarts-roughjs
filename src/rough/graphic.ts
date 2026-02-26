import rough from 'roughjs';
import Displayable, { DEFAULT_COMMON_STYLE } from 'zrender/lib/graphic/Displayable';
import PathProxy from 'zrender/lib/core/PathProxy';
import { GradientObject } from 'zrender/lib/graphic/Gradient';
import { ImagePatternObject, InnerImagePatternObject } from 'zrender/lib/graphic/Pattern';
import { ZRCanvasRenderingContext } from 'zrender/lib/core/types';
import { createOrUpdateImage, isImageReady } from 'zrender/lib/graphic/helper/image';
import { getCanvasGradient, isClipPathChanged } from './helper';
import Path, { PathStyleProps } from 'zrender/lib/graphic/Path';
import ZRImage, { ImageStyleProps } from 'zrender/lib/graphic/Image';
import TSpan, {TSpanStyleProps} from 'zrender/lib/graphic/TSpan';
import { MatrixArray } from 'zrender/lib/core/matrix';
import { RADIAN_TO_DEGREE } from 'zrender/lib/core/util';
import { getLineDash } from './dashStyle';
import { REDRAW_BIT, SHAPE_CHANGED_BIT } from 'zrender/lib/graphic/constants';
import type IncrementalDisplayable from 'zrender/lib/graphic/IncrementalDisplayable';
import { DEFAULT_FONT } from 'zrender/lib/core/platform';

// ─── Rough canvas cache ───────────────────────────────────────────────────────

const roughCanvasCache = new WeakMap<HTMLCanvasElement, ReturnType<typeof rough.canvas>>();

function getRoughCanvas(canvas: HTMLCanvasElement) {
    if (!roughCanvasCache.has(canvas)) {
        roughCanvasCache.set(canvas, rough.canvas(canvas));
    }
    return roughCanvasCache.get(canvas)!;
}

// ─── SVG path recorder ────────────────────────────────────────────────────────
// PathProxy.rebuildPath(ctx, percent) calls standard canvas path methods.
// We pass this recorder instead of a real ctx to collect SVG path commands.

class SVGPathRecorder {
    private parts: string[] = [];

    moveTo(x: number, y: number) {
        this.parts.push(`M ${x} ${y}`);
    }

    lineTo(x: number, y: number) {
        this.parts.push(`L ${x} ${y}`);
    }

    bezierCurveTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number) {
        this.parts.push(`C ${x1} ${y1} ${x2} ${y2} ${x} ${y}`);
    }

    quadraticCurveTo(x1: number, y1: number, x: number, y: number) {
        this.parts.push(`Q ${x1} ${y1} ${x} ${y}`);
    }

    // Canvas arc is in center form; convert to SVG endpoint arc notation.
    arc(cx: number, cy: number, r: number, startAngle: number, endAngle: number, anticlockwise?: boolean) {
        const startX = cx + r * Math.cos(startAngle);
        const startY = cy + r * Math.sin(startAngle);

        let sweep = anticlockwise
            ? startAngle - endAngle
            : endAngle - startAngle;

        if (sweep < 0) sweep += Math.PI * 2;
        if (sweep > Math.PI * 2) sweep = Math.PI * 2;
        if (sweep < 1e-10) return;

        const sweepFlag = anticlockwise ? 0 : 1;

        // Full circle: split into two semi-arcs (SVG A cannot draw a full circle)
        if (sweep >= Math.PI * 2 - 1e-6) {
            const midAngle = startAngle + Math.PI;
            const midX = cx + r * Math.cos(midAngle);
            const midY = cy + r * Math.sin(midAngle);
            this.parts.push(
                `M ${startX} ${startY}`,
                `A ${r} ${r} 0 1 ${sweepFlag} ${midX} ${midY}`,
                `A ${r} ${r} 0 1 ${sweepFlag} ${startX} ${startY}`
            );
            return;
        }

        const endX = cx + r * Math.cos(endAngle);
        const endY = cy + r * Math.sin(endAngle);
        const largeArcFlag = sweep > Math.PI ? 1 : 0;

        // Implicit lineTo from current canvas point to arc start (canvas behaviour)
        this.parts.push(
            `L ${startX} ${startY}`,
            `A ${r} ${r} 0 ${largeArcFlag} ${sweepFlag} ${endX} ${endY}`
        );
    }

    rect(x: number, y: number, w: number, h: number) {
        this.parts.push(`M ${x} ${y} L ${x + w} ${y} L ${x + w} ${y + h} L ${x} ${y + h} Z`);
    }

    closePath() {
        this.parts.push('Z');
    }

    getPath(): string {
        return this.parts.join(' ');
    }
}

// ─── Path utilities ───────────────────────────────────────────────────────────

const pathProxyForDraw = new PathProxy(true);

function styleHasStroke(style: PathStyleProps) {
    const stroke = style.stroke;
    return !(stroke == null || stroke === 'none' || !(style.lineWidth > 0));
}

function isValidStrokeFillStyle(
    v: PathStyleProps['stroke'] | PathStyleProps['fill']
): v is string {
    return typeof v === 'string' && v !== 'none';
}

function styleHasFill(style: PathStyleProps) {
    const fill = style.fill;
    return fill != null && fill !== 'none';
}

export function createCanvasPattern(
    this: void,
    ctx: CanvasRenderingContext2D,
    pattern: ImagePatternObject,
    el: {dirty: () => void}
): CanvasPattern {
    const image = createOrUpdateImage(pattern.image, (pattern as InnerImagePatternObject).__image, el);
    if (isImageReady(image)) {
        const canvasPattern = ctx.createPattern(image, pattern.repeat || 'repeat');
        if (typeof DOMMatrix === 'function' && canvasPattern && canvasPattern.setTransform) {
            const matrix = new DOMMatrix();
            matrix.translateSelf((pattern.x || 0), (pattern.y || 0));
            matrix.rotateSelf(0, 0, (pattern.rotation || 0) * RADIAN_TO_DEGREE);
            matrix.scaleSelf((pattern.scaleX || 1), (pattern.scaleY || 1));
            canvasPattern.setTransform(matrix);
        }
        return canvasPattern;
    }
}

// ─── Brush functions ──────────────────────────────────────────────────────────

function brushPath(ctx: CanvasRenderingContext2D, el: Path, style: PathStyleProps) {
    const strokePercent = style.strokePercent;
    const strokePart = strokePercent < 1;

    const firstDraw = !el.path;
    if ((!el.silent || strokePart) && firstDraw) {
        el.createPathProxy();
    }

    const path = el.path || pathProxyForDraw;
    const dirtyFlag = el.__dirty;

    // Always record into PathProxy (never draw directly to canvas ctx)
    if (firstDraw || (dirtyFlag & SHAPE_CHANGED_BIT)) {
        path.setDPR((ctx as any).dpr);
        path.setContext(null);
        path.reset();
        el.buildPath(path, el.shape, false);
        path.toStatic();
        el.pathUpdated();
    }

    // Replay recorded commands through our SVG recorder
    const recorder = new SVGPathRecorder();
    path.rebuildPath(recorder as any, strokePart ? strokePercent : 1);
    const svgPath = recorder.getPath();
    if (!svgPath) return;

    // Roughjs only accepts plain colour strings (no gradients/patterns)
    const fillColor = isValidStrokeFillStyle(style.fill as any) ? style.fill as string : 'none';
    const explicitStroke = styleHasStroke(style) && isValidStrokeFillStyle(style.stroke as any)
        ? style.stroke as string
        : 'none';

    const hasFill = fillColor !== 'none';

    // Filled shapes without an explicit stroke get a dark outline — correct for
    // the hand-drawn aesthetic and required for elements like gauge arc zones
    // that carry no borderColor in their ECharts style.
    const strokeColor = explicitStroke !== 'none' ? explicitStroke : hasFill ? '#333' : 'none';

    const rc = getRoughCanvas(ctx.canvas);
    rc.path(svgPath, {
        // Filled shapes (bars, areas) get the full sketchy treatment.
        // Stroke-only paths (axes, grid lines, ticks) use minimal roughness
        // so they stay legible at lineWidth 1.
        roughness: hasFill ? 1.5 : 0.4,
        bowing:    hasFill ? 1   : 0.3,
        stroke: strokeColor,
        strokeWidth: style.lineWidth || 1,
        fill: hasFill ? fillColor : undefined,
        fillStyle: 'hachure',
        hachureGap: 5,
    });
}

function brushImage(ctx: CanvasRenderingContext2D, el: ZRImage, style: ImageStyleProps) {
    const image = el.__image = createOrUpdateImage(style.image, el.__image, el, el.onload);
    if (!image || !isImageReady(image)) return;

    const x = style.x || 0;
    const y = style.y || 0;
    let width = el.getWidth();
    let height = el.getHeight();
    const aspect = image.width / image.height;
    if (width == null && height != null)       width = height * aspect;
    else if (height == null && width != null)  height = width / aspect;
    else if (width == null && height == null) { width = image.width; height = image.height; }

    if (style.sWidth && style.sHeight) {
        ctx.drawImage(image, style.sx || 0, style.sy || 0, style.sWidth, style.sHeight, x, y, width, height);
    }
    else if (style.sx && style.sy) {
        ctx.drawImage(image, style.sx, style.sy, width - style.sx, height - style.sy, x, y, width, height);
    }
    else {
        ctx.drawImage(image, x, y, width, height);
    }
}

function brushText(ctx: CanvasRenderingContext2D, el: TSpan, style: TSpanStyleProps) {
    let text = style.text;
    text != null && (text += '');
    if (!text) return;

    ctx.font = style.font || DEFAULT_FONT;
    ctx.textAlign = style.textAlign;
    ctx.textBaseline = style.textBaseline;

    let lineDash: number[] | false;
    let lineDashOffset: number;
    if (ctx.setLineDash && style.lineDash) {
        [lineDash, lineDashOffset] = getLineDash(el);
    }
    if (lineDash) { ctx.setLineDash(lineDash); ctx.lineDashOffset = lineDashOffset; }

    if (style.strokeFirst) {
        if (styleHasStroke(style)) ctx.strokeText(text, style.x, style.y);
        if (styleHasFill(style))   ctx.fillText(text, style.x, style.y);
    }
    else {
        if (styleHasFill(style))   ctx.fillText(text, style.x, style.y);
        if (styleHasStroke(style)) ctx.strokeText(text, style.x, style.y);
    }

    if (lineDash) ctx.setLineDash([]);
}

// ─── Style binding ────────────────────────────────────────────────────────────

const SHADOW_NUMBER_PROPS = ['shadowBlur', 'shadowOffsetX', 'shadowOffsetY'] as const;
const STROKE_PROPS = [
    ['lineCap', 'butt'], ['lineJoin', 'miter'], ['miterLimit', 10]
] as const;

type AllStyleOption = PathStyleProps | TSpanStyleProps | ImageStyleProps;

function bindCommonProps(
    ctx: CanvasRenderingContext2D,
    style: AllStyleOption,
    prevStyle: AllStyleOption,
    forceSetAll: boolean,
    scope: BrushScope
): boolean {
    let styleChanged = false;
    if (!forceSetAll) {
        prevStyle = prevStyle || {};
        if (style === prevStyle) return false;
    }
    if (forceSetAll || style.opacity !== prevStyle.opacity) {
        flushPathDrawn(ctx, scope);
        styleChanged = true;
        const opacity = Math.max(Math.min(style.opacity, 1), 0);
        ctx.globalAlpha = isNaN(opacity) ? DEFAULT_COMMON_STYLE.opacity : opacity;
    }
    if (forceSetAll || style.blend !== prevStyle.blend) {
        if (!styleChanged) { flushPathDrawn(ctx, scope); styleChanged = true; }
        ctx.globalCompositeOperation = style.blend || DEFAULT_COMMON_STYLE.blend;
    }
    for (let i = 0; i < SHADOW_NUMBER_PROPS.length; i++) {
        const propName = SHADOW_NUMBER_PROPS[i];
        if (forceSetAll || style[propName] !== prevStyle[propName]) {
            if (!styleChanged) { flushPathDrawn(ctx, scope); styleChanged = true; }
            ctx[propName] = (ctx as ZRCanvasRenderingContext).dpr * (style[propName] || 0);
        }
    }
    if (forceSetAll || style.shadowColor !== prevStyle.shadowColor) {
        if (!styleChanged) { flushPathDrawn(ctx, scope); styleChanged = true; }
        ctx.shadowColor = style.shadowColor || DEFAULT_COMMON_STYLE.shadowColor;
    }
    return styleChanged;
}

function bindPathAndTextCommonStyle(
    ctx: CanvasRenderingContext2D,
    el: TSpan | Path,
    prevEl: TSpan | Path,
    forceSetAll: boolean,
    scope: BrushScope
) {
    const style = getStyle(el, scope.inHover);
    const prevStyle = forceSetAll ? null : (prevEl && getStyle(prevEl, scope.inHover) || {});
    if (style === prevStyle) return false;

    let styleChanged = bindCommonProps(ctx, style, prevStyle, forceSetAll, scope);

    if (forceSetAll || style.fill !== prevStyle.fill) {
        if (!styleChanged) { flushPathDrawn(ctx, scope); styleChanged = true; }
        isValidStrokeFillStyle(style.fill) && (ctx.fillStyle = style.fill);
    }
    if (forceSetAll || style.stroke !== prevStyle.stroke) {
        if (!styleChanged) { flushPathDrawn(ctx, scope); styleChanged = true; }
        isValidStrokeFillStyle(style.stroke) && (ctx.strokeStyle = style.stroke);
    }
    if (forceSetAll || style.opacity !== prevStyle.opacity) {
        if (!styleChanged) { flushPathDrawn(ctx, scope); styleChanged = true; }
        ctx.globalAlpha = style.opacity == null ? 1 : style.opacity;
    }
    if (el.hasStroke()) {
        const newLineWidth = style.lineWidth / (
            (style.strokeNoScale && el.getLineScale) ? el.getLineScale() : 1
        );
        if (ctx.lineWidth !== newLineWidth) {
            if (!styleChanged) { flushPathDrawn(ctx, scope); styleChanged = true; }
            ctx.lineWidth = newLineWidth;
        }
    }
    for (let i = 0; i < STROKE_PROPS.length; i++) {
        const prop = STROKE_PROPS[i];
        const propName = prop[0];
        if (forceSetAll || style[propName] !== prevStyle[propName]) {
            if (!styleChanged) { flushPathDrawn(ctx, scope); styleChanged = true; }
            (ctx as any)[propName] = style[propName] || prop[1];
        }
    }
    return styleChanged;
}

function bindImageStyle(
    ctx: CanvasRenderingContext2D,
    el: ZRImage,
    prevEl: ZRImage,
    forceSetAll: boolean,
    scope: BrushScope
) {
    return bindCommonProps(ctx, getStyle(el, scope.inHover), prevEl && getStyle(prevEl, scope.inHover), forceSetAll, scope);
}

function setContextTransform(ctx: CanvasRenderingContext2D, el: Displayable) {
    const m = el.transform;
    const dpr = (ctx as ZRCanvasRenderingContext).dpr || 1;
    if (m) {
        ctx.setTransform(dpr * m[0], dpr * m[1], dpr * m[2], dpr * m[3], dpr * m[4], dpr * m[5]);
    }
    else {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
}

function updateClipStatus(_clipPaths: Path[], _ctx: CanvasRenderingContext2D, scope: BrushScope) {
    // Clip paths are ignored in the rough renderer. In ECharts they exist almost
    // exclusively to drive entry animations (e.g. gauge arc reveal, line draw-on).
    // This painter is a static snapshot renderer and has no animation loop, so
    // applying them would permanently hide elements that are waiting to be revealed.
    scope.allClipped = false;
}

function isTransformChanged(m0: MatrixArray, m1: MatrixArray): boolean {
    if (m0 && m1) {
        return m0[0] !== m1[0] || m0[1] !== m1[1] || m0[2] !== m1[2]
            || m0[3] !== m1[3] || m0[4] !== m1[4] || m0[5] !== m1[5];
    }
    return !m0 !== !m1;
}

const DRAW_TYPE_PATH        = 1;
const DRAW_TYPE_IMAGE       = 2;
const DRAW_TYPE_TEXT        = 3;
const DRAW_TYPE_INCREMENTAL = 4;

export type BrushScope = {
    inHover: boolean
    viewWidth: number
    viewHeight: number
    prevElClipPaths?: Path[]
    prevEl?: Displayable
    allClipped?: boolean
    batchFill?: string
    batchStroke?: string
    lastDrawType?: number
}

// No-op: roughjs handles each path individually, no canvas-level batching
function flushPathDrawn(_ctx: CanvasRenderingContext2D, scope: BrushScope) {
    scope.batchFill = '';
    scope.batchStroke = '';
}

function getStyle(el: Displayable, inHover?: boolean) {
    return inHover ? (el.__hoverStyle || el.style) : el.style;
}

export function brushSingle(ctx: CanvasRenderingContext2D, el: Displayable) {
    brush(ctx, el, { inHover: false, viewWidth: 0, viewHeight: 0 }, true);
}

// ─── Main brush dispatcher ────────────────────────────────────────────────────

export function brush(
    ctx: CanvasRenderingContext2D,
    el: Displayable,
    scope: BrushScope,
    isLast: boolean
) {
    // Skip viewport culling: element bounding rects may not be computed yet on
    // first draw (path is built lazily inside brushPath). shouldBePainted would
    // falsely return false for those elements, hiding them permanently.
    // We only respect the hard `ignore` flag.
    if (el.ignore) {
        return;
    }

    const clipPaths = el.__clipPaths;
    const prevElClipPaths = scope.prevElClipPaths;

    let forceSetTransform = false;
    let forceSetStyle = false;

    if (!prevElClipPaths || isClipPathChanged(clipPaths, prevElClipPaths)) {
        if (prevElClipPaths && prevElClipPaths.length) {
            flushPathDrawn(ctx, scope);
            ctx.restore();
            forceSetStyle = forceSetTransform = true;
            scope.prevElClipPaths = null;
            scope.allClipped = false;
            scope.prevEl = null;
        }
        if (clipPaths && clipPaths.length) {
            flushPathDrawn(ctx, scope);
            ctx.save();
            updateClipStatus(clipPaths, ctx, scope);
            forceSetTransform = true;
        }
        scope.prevElClipPaths = clipPaths;
    }

    if (scope.allClipped) {
        el.__isRendered = false;
        return;
    }

    el.beforeBrush && el.beforeBrush();
    el.innerBeforeBrush();

    const prevEl = scope.prevEl;
    if (!prevEl) forceSetStyle = forceSetTransform = true;

    // No batching in rough renderer
    if (forceSetTransform || isTransformChanged(el.transform, prevEl.transform)) {
        flushPathDrawn(ctx, scope);
        setContextTransform(ctx, el);
    }
    else {
        flushPathDrawn(ctx, scope);
    }

    const style = getStyle(el, scope.inHover);

    if (el instanceof Path) {
        if (scope.lastDrawType !== DRAW_TYPE_PATH) { forceSetStyle = true; scope.lastDrawType = DRAW_TYPE_PATH; }
        bindPathAndTextCommonStyle(ctx, el as Path, prevEl as Path, forceSetStyle, scope);
        brushPath(ctx, el as Path, style);
    }
    else if (el instanceof TSpan) {
        if (scope.lastDrawType !== DRAW_TYPE_TEXT) { forceSetStyle = true; scope.lastDrawType = DRAW_TYPE_TEXT; }
        bindPathAndTextCommonStyle(ctx, el as TSpan, prevEl as TSpan, forceSetStyle, scope);
        brushText(ctx, el as TSpan, style);
    }
    else if (el instanceof ZRImage) {
        if (scope.lastDrawType !== DRAW_TYPE_IMAGE) { forceSetStyle = true; scope.lastDrawType = DRAW_TYPE_IMAGE; }
        bindImageStyle(ctx, el as ZRImage, prevEl as ZRImage, forceSetStyle, scope);
        brushImage(ctx, el as ZRImage, style);
    }
    else if ((el as IncrementalDisplayable).getTemporalDisplayables) {
        if (scope.lastDrawType !== DRAW_TYPE_INCREMENTAL) { forceSetStyle = true; scope.lastDrawType = DRAW_TYPE_INCREMENTAL; }
        brushIncremental(ctx, el as IncrementalDisplayable, scope);
    }

    el.innerAfterBrush();
    el.afterBrush && el.afterBrush();
    scope.prevEl = el;
    el.__dirty = 0;
    el.__isRendered = true;
}

function brushIncremental(
    ctx: CanvasRenderingContext2D,
    el: IncrementalDisplayable,
    scope: BrushScope
) {
    const displayables = el.getDisplayables();
    const temporalDisplayables = el.getTemporalDisplayables();
    ctx.save();
    const innerScope: BrushScope = {
        prevElClipPaths: null, prevEl: null, allClipped: false,
        viewWidth: scope.viewWidth, viewHeight: scope.viewHeight, inHover: scope.inHover
    };
    let i, len;
    for (i = el.getCursor(), len = displayables.length; i < len; i++) {
        const d = displayables[i];
        d.beforeBrush && d.beforeBrush();
        d.innerBeforeBrush();
        brush(ctx, d, innerScope, i === len - 1);
        d.innerAfterBrush();
        d.afterBrush && d.afterBrush();
        innerScope.prevEl = d;
    }
    for (let i = 0, len = temporalDisplayables.length; i < len; i++) {
        const d = temporalDisplayables[i];
        d.beforeBrush && d.beforeBrush();
        d.innerBeforeBrush();
        brush(ctx, d, innerScope, i === len - 1);
        d.innerAfterBrush();
        d.afterBrush && d.afterBrush();
        innerScope.prevEl = d;
    }
    el.clearTemporalDisplayables();
    el.notClear = true;
    ctx.restore();
}
