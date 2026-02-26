import * as util from 'zrender/lib/core/util';
import {devicePixelRatio} from 'zrender/lib/config';
import { ImagePatternObject } from 'zrender/lib/graphic/Pattern';
import RPainter from './Painter';
import { GradientObject, InnerGradientObject } from 'zrender/lib/graphic/Gradient';
import { ZRCanvasRenderingContext } from 'zrender/lib/core/types';
import Eventful from 'zrender/lib/core/Eventful';
import { ElementEventCallback } from 'zrender/lib/Element';
import { getCanvasGradient } from './helper';
import { createCanvasPattern } from './graphic';
import Displayable from 'zrender/lib/graphic/Displayable';
import BoundingRect from 'zrender/lib/core/BoundingRect';
import { REDRAW_BIT } from 'zrender/lib/graphic/constants';
import { platformApi } from 'zrender/lib/core/platform';

export interface LayerConfig {
    clearColor?: string | GradientObject | ImagePatternObject
    motionBlur?: boolean
    lastFrameAlpha?: number
};

function createDom(id: string, painter: RPainter, dpr: number) {
    const newDom = platformApi.createCanvas();
    const width = painter.getWidth();
    const height = painter.getHeight();

    const newDomStyle = newDom.style;
    if (newDomStyle) {
        newDomStyle.position = 'absolute';
        newDomStyle.left = '0';
        newDomStyle.top = '0';
        newDomStyle.width = width + 'px';
        newDomStyle.height = height + 'px';

        newDom.setAttribute('data-zr-dom-id', id);
    }

    newDom.width = width * dpr;
    newDom.height = height * dpr;

    return newDom;
}

export default class Layer extends Eventful {

    id: string

    dom: HTMLCanvasElement
    domBack: HTMLCanvasElement

    ctx: CanvasRenderingContext2D
    ctxBack: CanvasRenderingContext2D

    painter: RPainter

    clearColor: string | GradientObject | ImagePatternObject
    motionBlur = false
    lastFrameAlpha = 0.7
    dpr = 1

    virtual = false

    config = {}

    incremental = false

    zlevel = 0

    maxRepaintRectCount = 5

    private _paintRects: BoundingRect[]

    __dirty = true
    __firstTimePaint = true

    __used = false

    __drawIndex = 0
    __startIndex = 0
    __endIndex = 0

    __prevStartIndex: number = null
    __prevEndIndex: number = null

    __builtin__: boolean

    constructor(id: string | HTMLCanvasElement, painter: RPainter, dpr?: number) {
        super();

        let dom;
        dpr = dpr || devicePixelRatio;
        if (typeof id === 'string') {
            dom = createDom(id, painter, dpr);
        }
        else if (util.isObject(id)) {
            dom = id;
            id = dom.id;
        }
        this.id = id as string;
        this.dom = dom;

        const domStyle = dom.style;
        if (domStyle) {
            util.disableUserSelect(dom);
            dom.onselectstart = () => false;
            domStyle.padding = '0';
            domStyle.margin = '0';
            domStyle.borderWidth = '0';
        }

        this.painter = painter;

        this.dpr = dpr;
    }

    getElementCount() {
        return this.__endIndex - this.__startIndex;
    }

    afterBrush() {
        this.__prevStartIndex = this.__startIndex;
        this.__prevEndIndex = this.__endIndex;
    }

    initContext() {
        this.ctx = this.dom.getContext('2d');
        (this.ctx as ZRCanvasRenderingContext).dpr = this.dpr;
    }

    setUnpainted() {
        this.__firstTimePaint = true;
    }

    createBackBuffer() {
        const dpr = this.dpr;

        this.domBack = createDom('back-' + this.id, this.painter, dpr);
        this.ctxBack = this.domBack.getContext('2d');

        if (dpr !== 1) {
            this.ctxBack.scale(dpr, dpr);
        }
    }

    createRepaintRects(
        displayList: Displayable[],
        prevList: Displayable[],
        viewWidth: number,
        viewHeight: number
    ) {
        if (this.__firstTimePaint) {
            this.__firstTimePaint = false;
            return null;
        }

        const mergedRepaintRects: BoundingRect[] = [];
        const maxRepaintRectCount = this.maxRepaintRectCount;
        let full = false;
        const pendingRect = new BoundingRect(0, 0, 0, 0);

        function addRectToMergePool(rect: BoundingRect) {
            if (!rect.isFinite() || rect.isZero()) {
                return;
            }

            if (mergedRepaintRects.length === 0) {
                const boundingRect = new BoundingRect(0, 0, 0, 0);
                boundingRect.copy(rect);
                mergedRepaintRects.push(boundingRect);
            }
            else {
                let isMerged = false;
                let minDeltaArea = Infinity;
                let bestRectToMergeIdx = 0;
                for (let i = 0; i < mergedRepaintRects.length; ++i) {
                    const mergedRect = mergedRepaintRects[i];

                    if (mergedRect.intersect(rect)) {
                        const pendingRect = new BoundingRect(0, 0, 0, 0);
                        pendingRect.copy(mergedRect);
                        pendingRect.union(rect);
                        mergedRepaintRects[i] = pendingRect;
                        isMerged = true;
                        break;
                    }
                    else if (full) {
                        pendingRect.copy(rect);
                        pendingRect.union(mergedRect);
                        const aArea = rect.width * rect.height;
                        const bArea = mergedRect.width * mergedRect.height;
                        const pendingArea = pendingRect.width * pendingRect.height;
                        const deltaArea = pendingArea - aArea - bArea;
                        if (deltaArea < minDeltaArea) {
                            minDeltaArea = deltaArea;
                            bestRectToMergeIdx = i;
                        }
                    }
                }

                if (full) {
                    mergedRepaintRects[bestRectToMergeIdx].union(rect);
                    isMerged = true;
                }

                if (!isMerged) {
                    const boundingRect = new BoundingRect(0, 0, 0, 0);
                    boundingRect.copy(rect);
                    mergedRepaintRects.push(boundingRect);
                }
                if (!full) {
                    full = mergedRepaintRects.length >= maxRepaintRectCount;
                }
            }
        }

        for (let i = this.__startIndex; i < this.__endIndex; ++i) {
            const el = displayList[i];
            if (el) {
                const shouldPaint = el.shouldBePainted(viewWidth, viewHeight, true, true);
                const prevRect = el.__isRendered && ((el.__dirty & REDRAW_BIT) || !shouldPaint)
                    ? el.getPrevPaintRect()
                    : null;
                if (prevRect) {
                    addRectToMergePool(prevRect);
                }

                const curRect = shouldPaint && ((el.__dirty & REDRAW_BIT) || !el.__isRendered)
                    ? el.getPaintRect()
                    : null;
                if (curRect) {
                    addRectToMergePool(curRect);
                }
            }
        }

        for (let i = this.__prevStartIndex; i < this.__prevEndIndex; ++i) {
            const el = prevList[i];
            const shouldPaint = el && el.shouldBePainted(viewWidth, viewHeight, true, true);
            if (el && (!shouldPaint || !el.__zr) && el.__isRendered) {
                const prevRect = el.getPrevPaintRect();
                if (prevRect) {
                    addRectToMergePool(prevRect);
                }
            }
        }

        let hasIntersections;
        do {
            hasIntersections = false;
            for (let i = 0; i < mergedRepaintRects.length;) {
                if (mergedRepaintRects[i].isZero()) {
                    mergedRepaintRects.splice(i, 1);
                    continue;
                }
                for (let j = i + 1; j < mergedRepaintRects.length;) {
                    if (mergedRepaintRects[i].intersect(mergedRepaintRects[j])) {
                        hasIntersections = true;
                        mergedRepaintRects[i].union(mergedRepaintRects[j]);
                        mergedRepaintRects.splice(j, 1);
                    }
                    else {
                        j++;
                    }
                }
                i++;
            }
        } while (hasIntersections);

        this._paintRects = mergedRepaintRects;

        return mergedRepaintRects;
    }

    debugGetPaintRects() {
        return (this._paintRects || []).slice();
    }

    resize(width: number, height: number) {
        const dpr = this.dpr;

        const dom = this.dom;
        const domStyle = dom.style;
        const domBack = this.domBack;

        if (domStyle) {
            domStyle.width = width + 'px';
            domStyle.height = height + 'px';
        }

        dom.width = width * dpr;
        dom.height = height * dpr;

        if (domBack) {
            domBack.width = width * dpr;
            domBack.height = height * dpr;

            if (dpr !== 1) {
                this.ctxBack.scale(dpr, dpr);
            }
        }
    }

    clear(
        clearAll?: boolean,
        clearColor?: string | GradientObject | ImagePatternObject,
        repaintRects?: BoundingRect[]
    ) {
        const dom = this.dom;
        const ctx = this.ctx;
        const width = dom.width;
        const height = dom.height;

        clearColor = clearColor || this.clearColor;
        const haveMotionBLur = this.motionBlur && !clearAll;
        const lastFrameAlpha = this.lastFrameAlpha;

        const dpr = this.dpr;
        const self = this;

        if (haveMotionBLur) {
            if (!this.domBack) {
                this.createBackBuffer();
            }

            this.ctxBack.globalCompositeOperation = 'copy';
            this.ctxBack.drawImage(
                dom, 0, 0,
                width / dpr,
                height / dpr
            );
        }

        const domBack = this.domBack;

        function doClear(x: number, y: number, width: number, height: number) {
            ctx.clearRect(x, y, width, height);
            if (clearColor && clearColor !== 'transparent') {
                let clearColorGradientOrPattern;
                if (util.isGradientObject(clearColor)) {
                    const shouldCache = clearColor.global || (
                        (clearColor as InnerGradientObject).__width === width
                        && (clearColor as InnerGradientObject).__height === height
                    );
                    clearColorGradientOrPattern = shouldCache
                        && (clearColor as InnerGradientObject).__canvasGradient
                        || getCanvasGradient(ctx, clearColor, {
                            x: 0,
                            y: 0,
                            width: width,
                            height: height
                        });

                    (clearColor as InnerGradientObject).__canvasGradient = clearColorGradientOrPattern;
                    (clearColor as InnerGradientObject).__width = width;
                    (clearColor as InnerGradientObject).__height = height;
                }
                else if (util.isImagePatternObject(clearColor)) {
                    clearColor.scaleX = clearColor.scaleX || dpr;
                    clearColor.scaleY = clearColor.scaleY || dpr;
                    clearColorGradientOrPattern = createCanvasPattern(
                        ctx, clearColor, {
                            dirty() {
                                self.setUnpainted();
                                self.painter.refresh();
                            }
                        }
                    );
                }
                ctx.save();
                ctx.fillStyle = clearColorGradientOrPattern || (clearColor as string);
                ctx.fillRect(x, y, width, height);
                ctx.restore();
            }

            if (haveMotionBLur) {
                ctx.save();
                ctx.globalAlpha = lastFrameAlpha;
                ctx.drawImage(domBack, x, y, width, height);
                ctx.restore();
            }
        };

        if (!repaintRects || haveMotionBLur) {
            doClear(0, 0, width, height);
        }
        else if (repaintRects.length) {
            util.each(repaintRects, rect => {
                doClear(
                    rect.x * dpr,
                    rect.y * dpr,
                    rect.width * dpr,
                    rect.height * dpr
                );
            });
        }
    }

    refresh: (clearColor?: string | GradientObject | ImagePatternObject) => void

    renderToCanvas: (ctx: CanvasRenderingContext2D) => void

    onclick: ElementEventCallback<unknown, this>
    ondblclick: ElementEventCallback<unknown, this>
    onmouseover: ElementEventCallback<unknown, this>
    onmouseout: ElementEventCallback<unknown, this>
    onmousemove: ElementEventCallback<unknown, this>
    onmousewheel: ElementEventCallback<unknown, this>
    onmousedown: ElementEventCallback<unknown, this>
    onmouseup: ElementEventCallback<unknown, this>
    oncontextmenu: ElementEventCallback<unknown, this>

    ondrag: ElementEventCallback<unknown, this>
    ondragstart: ElementEventCallback<unknown, this>
    ondragend: ElementEventCallback<unknown, this>
    ondragenter: ElementEventCallback<unknown, this>
    ondragleave: ElementEventCallback<unknown, this>
    ondragover: ElementEventCallback<unknown, this>
    ondrop: ElementEventCallback<unknown, this>
}
