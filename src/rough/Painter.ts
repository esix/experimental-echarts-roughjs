import {devicePixelRatio} from 'zrender/lib/config';
import * as util from 'zrender/lib/core/util';
import Layer, { LayerConfig } from './Layer';
import requestAnimationFrame from 'zrender/lib/animation/requestAnimationFrame';
import env from 'zrender/lib/core/env';
import Displayable from 'zrender/lib/graphic/Displayable';
import { WXCanvasRenderingContext } from 'zrender/lib/core/types';
import { GradientObject } from 'zrender/lib/graphic/Gradient';
import { ImagePatternObject } from 'zrender/lib/graphic/Pattern';
import Storage from 'zrender/lib/Storage';
import { brush, BrushScope, brushSingle } from './graphic';
import { PainterBase } from 'zrender/lib/PainterBase';
import BoundingRect from 'zrender/lib/core/BoundingRect';
import { REDRAW_BIT } from 'zrender/lib/graphic/constants';
import { getSize } from './helper';
import type IncrementalDisplayable from 'zrender/lib/graphic/IncrementalDisplayable';

const HOVER_LAYER_ZLEVEL = 1e5;
const CANVAS_ZLEVEL = 314159;

const EL_AFTER_INCREMENTAL_INC = 0.01;
const INCREMENTAL_INC = 0.001;


function isLayerValid(layer: Layer) {
    if (!layer) {
        return false;
    }

    if (layer.__builtin__) {
        return true;
    }

    if (typeof (layer.resize) !== 'function'
        || typeof (layer.refresh) !== 'function'
    ) {
        return false;
    }

    return true;
}

function createRoot(width: number, height: number) {
    const domRoot = document.createElement('div');

    domRoot.style.cssText = [
        'position:relative',
        'width:' + width + 'px',
        'height:' + height + 'px',
        'padding:0',
        'margin:0',
        'border-width:0'
    ].join(';') + ';';

    return domRoot;
}

interface RPainterOption {
    devicePixelRatio?: number
    width?: number | string
    height?: number | string,
    useDirtyRect?: boolean
}

export default class RPainter implements PainterBase {

    type = 'rough'

    root: HTMLElement

    dpr: number

    storage: Storage

    private _singleCanvas: boolean

    private _opts: RPainterOption

    private _zlevelList: number[] = []

    private _prevDisplayList: Displayable[] = []

    private _layers: {[key: number]: Layer} = {}

    private _layerConfig: {[key: number]: LayerConfig} = {}

    private _needsManuallyCompositing = false

    private _width: number
    private _height: number

    private _domRoot: HTMLElement

    private _hoverlayer: Layer

    private _redrawId: number

    private _backgroundColor: string | GradientObject | ImagePatternObject


    constructor(root: HTMLElement, storage: Storage, opts: RPainterOption, id: number) {

        this.type = 'rough';

        const singleCanvas = !root.nodeName
            || root.nodeName.toUpperCase() === 'CANVAS';

        this._opts = opts = util.extend({}, opts || {}) as RPainterOption;

        this.dpr = opts.devicePixelRatio || devicePixelRatio;
        this._singleCanvas = singleCanvas;
        this.root = root;

        const rootStyle = root.style;

        if (rootStyle) {
            // @ts-ignore
            util.disableUserSelect(root);
            root.innerHTML = '';
        }

        this.storage = storage;

        const zlevelList: number[] = this._zlevelList;

        this._prevDisplayList = [];

        const layers = this._layers;

        if (!singleCanvas) {
            this._width = getSize(root, 0, opts);
            this._height = getSize(root, 1, opts);

            const domRoot = this._domRoot = createRoot(
                this._width, this._height
            );
            root.appendChild(domRoot);
        }
        else {
            const rootCanvas = root as HTMLCanvasElement;
            let width = rootCanvas.width;
            let height = rootCanvas.height;

            if (opts.width != null) {
                width = opts.width as number;
            }
            if (opts.height != null) {
                height = opts.height as number;
            }
            this.dpr = opts.devicePixelRatio || 1;

            rootCanvas.width = width * this.dpr;
            rootCanvas.height = height * this.dpr;

            this._width = width;
            this._height = height;

            const mainLayer = new Layer(rootCanvas, this, this.dpr);
            mainLayer.__builtin__ = true;
            mainLayer.initContext();
            layers[CANVAS_ZLEVEL] = mainLayer;
            mainLayer.zlevel = CANVAS_ZLEVEL;
            zlevelList.push(CANVAS_ZLEVEL);

            this._domRoot = root;
        }
    }


    getType() {
        return 'rough';
    }

    isSingleCanvas() {
        return this._singleCanvas;
    }

    getViewportRoot() {
        return this._domRoot;
    }

    getViewportRootOffset() {
        const viewportRoot = this.getViewportRoot();
        if (viewportRoot) {
            return {
                offsetLeft: viewportRoot.offsetLeft || 0,
                offsetTop: viewportRoot.offsetTop || 0
            };
        }
    }

    refresh(paintAll?: boolean) {
        const list = this.storage.getDisplayList(true);
        const prevList = this._prevDisplayList;

        const zlevelList = this._zlevelList;

        this._redrawId = Math.random();

        // Always repaint all layers — roughjs redraws from scratch every time,
        // so dirty-layer skipping only causes elements to be missed.
        this._paintList(list, prevList, true, this._redrawId);

        for (let i = 0; i < zlevelList.length; i++) {
            const z = zlevelList[i];
            const layer = this._layers[z];
            if (!layer.__builtin__ && layer.refresh) {
                const clearColor = i === 0 ? this._backgroundColor : null;
                layer.refresh(clearColor);
            }
        }

        if (this._opts.useDirtyRect) {
            this._prevDisplayList = list.slice();
        }

        return this;
    }


    refreshHover() {
        this._paintHoverList(this.storage.getDisplayList(false));
    }

    private _paintHoverList(list: Displayable[]) {
        let len = list.length;
        let hoverLayer = this._hoverlayer;
        hoverLayer && hoverLayer.clear();

        if (!len) {
            return;
        }

        const scope: BrushScope = {
            inHover: true,
            viewWidth: this._width,
            viewHeight: this._height
        };

        let ctx;
        for (let i = 0; i < len; i++) {
            const el = list[i];
            if (el.__inHover) {
                if (!hoverLayer) {
                    hoverLayer = this._hoverlayer = this.getLayer(HOVER_LAYER_ZLEVEL);
                }

                if (!ctx) {
                    ctx = hoverLayer.ctx;
                    ctx.save();
                }

                brush(ctx, el, scope, i === len - 1);
            }
        }
        if (ctx) {
            ctx.restore();
        }
    }

    getHoverLayer() {
        return this.getLayer(HOVER_LAYER_ZLEVEL);
    }

    paintOne(ctx: CanvasRenderingContext2D, el: Displayable) {
        brushSingle(ctx, el);
    }

    private _paintList(list: Displayable[], prevList: Displayable[], paintAll: boolean, redrawId?: number) {
        if (this._redrawId !== redrawId) {
            return;
        }

        paintAll = paintAll || false;

        this._updateLayerStatus(list);

        const {finished, needsRefreshHover} = this._doPaintList(list, prevList, paintAll);

        if (this._needsManuallyCompositing) {
            this._compositeManually();
        }

        if (needsRefreshHover) {
            this._paintHoverList(list);
        }

        if (!finished) {
            const self = this;
            requestAnimationFrame(function () {
                self._paintList(list, prevList, paintAll, redrawId);
            });
        }
        else {
            this.eachLayer(layer => {
                layer.afterBrush && layer.afterBrush();
            });
        }
    }

    private _compositeManually() {
        const ctx = this.getLayer(CANVAS_ZLEVEL).ctx;
        const width = (this._domRoot as HTMLCanvasElement).width;
        const height = (this._domRoot as HTMLCanvasElement).height;
        ctx.clearRect(0, 0, width, height);
        this.eachBuiltinLayer(function (layer) {
            if (layer.virtual) {
                ctx.drawImage(layer.dom, 0, 0, width, height);
            }
        });
    }

    private _doPaintList(
        list: Displayable[],
        prevList: Displayable[],
        paintAll?: boolean
    ): {
        finished: boolean
        needsRefreshHover: boolean
    } {
        const layerList = [];
        const useDirtyRect = this._opts.useDirtyRect;
        for (let zi = 0; zi < this._zlevelList.length; zi++) {
            const zlevel = this._zlevelList[zi];
            const layer = this._layers[zlevel];
            if (layer.__builtin__
                && layer !== this._hoverlayer
                && (layer.__dirty || paintAll)
            ) {
                layerList.push(layer);
            }
        }

        let finished = true;
        let needsRefreshHover = false;

        for (let k = 0; k < layerList.length; k++) {
            const layer = layerList[k];
            const ctx = layer.ctx;

            const repaintRects = useDirtyRect
                && layer.createRepaintRects(list, prevList, this._width, this._height);

            let start = paintAll ? layer.__startIndex : layer.__drawIndex;

            const useTimer = !paintAll && layer.incremental && Date.now;
            const startTime = useTimer && Date.now();

            const clearColor = layer.zlevel === this._zlevelList[0]
                ? this._backgroundColor : null;

            if (layer.__startIndex === layer.__endIndex) {
                layer.clear(false, clearColor, repaintRects);
            }
            else if (start === layer.__startIndex) {
                const firstEl = list[start];
                if (!firstEl.incremental || !(firstEl as IncrementalDisplayable).notClear || paintAll) {
                    layer.clear(false, clearColor, repaintRects);
                }
            }
            if (start === -1) {
                console.error('For some unknown reason. drawIndex is -1');
                start = layer.__startIndex;
            }
            let i: number;
            /* eslint-disable-next-line */
            const repaint = (repaintRect?: BoundingRect) => {
                const scope: BrushScope = {
                    inHover: false,
                    allClipped: false,
                    prevEl: null,
                    viewWidth: this._width,
                    viewHeight: this._height
                };

                for (i = start; i < layer.__endIndex; i++) {
                    const el = list[i];

                    if (el.__inHover) {
                        needsRefreshHover = true;
                    }

                    this._doPaintEl(el, layer, useDirtyRect, repaintRect, scope, i === layer.__endIndex - 1);

                    if (useTimer) {
                        const dTime = Date.now() - startTime;
                        if (dTime > 15) {
                            break;
                        }
                    }
                }

                if (scope.prevElClipPaths) {
                    ctx.restore();
                }
            };

            if (repaintRects) {
                if (repaintRects.length === 0) {
                    i = layer.__endIndex;
                }
                else {
                    const dpr = this.dpr;
                    for (var r = 0; r < repaintRects.length; ++r) {
                        const rect = repaintRects[r];

                        ctx.save();
                        ctx.beginPath();
                        ctx.rect(
                            rect.x * dpr,
                            rect.y * dpr,
                            rect.width * dpr,
                            rect.height * dpr
                        );
                        ctx.clip();

                        repaint(rect);
                        ctx.restore();
                    }
                }
            }
            else {
                ctx.save();
                repaint();
                ctx.restore();
            }

            layer.__drawIndex = i;

            if (layer.__drawIndex < layer.__endIndex) {
                finished = false;
            }
        }

        if (env.wxa) {
            util.each(this._layers, function (layer) {
                if (layer && layer.ctx && (layer.ctx as WXCanvasRenderingContext).draw) {
                    (layer.ctx as WXCanvasRenderingContext).draw();
                }
            });
        }

        return {
            finished,
            needsRefreshHover
        };
    }

    private _doPaintEl(
        el: Displayable,
        currentLayer: Layer,
        useDirtyRect: boolean,
        repaintRect: BoundingRect,
        scope: BrushScope,
        isLast: boolean
    ) {
        const ctx = currentLayer.ctx;
        if (useDirtyRect) {
            const paintRect = el.getPaintRect();
            if (!repaintRect || paintRect && paintRect.intersect(repaintRect)) {
                brush(ctx, el, scope, isLast);
                el.setPrevPaintRect(paintRect);
            }
        }
        else {
            brush(ctx, el, scope, isLast);
        }
    }

    getLayer(zlevel: number, virtual?: boolean) {
        if (this._singleCanvas && !this._needsManuallyCompositing) {
            zlevel = CANVAS_ZLEVEL;
        }
        let layer = this._layers[zlevel];
        if (!layer) {
            layer = new Layer('zr_' + zlevel, this, this.dpr);
            layer.zlevel = zlevel;
            layer.__builtin__ = true;

            if (this._layerConfig[zlevel]) {
                util.merge(layer, this._layerConfig[zlevel], true);
            }
            else if (this._layerConfig[zlevel - EL_AFTER_INCREMENTAL_INC]) {
                util.merge(layer, this._layerConfig[zlevel - EL_AFTER_INCREMENTAL_INC], true);
            }

            if (virtual) {
                layer.virtual = virtual;
            }

            this.insertLayer(zlevel, layer);

            layer.initContext();
        }

        return layer;
    }

    insertLayer(zlevel: number, layer: Layer) {

        const layersMap = this._layers;
        const zlevelList = this._zlevelList;
        const len = zlevelList.length;
        const domRoot = this._domRoot;
        let prevLayer = null;
        let i = -1;

        if (layersMap[zlevel]) {
            if (process.env.NODE_ENV !== 'production') {
                util.logError('ZLevel ' + zlevel + ' has been used already');
            }
            return;
        }
        if (!isLayerValid(layer)) {
            if (process.env.NODE_ENV !== 'production') {
                util.logError('Layer of zlevel ' + zlevel + ' is not valid');
            }
            return;
        }

        if (len > 0 && zlevel > zlevelList[0]) {
            for (i = 0; i < len - 1; i++) {
                if (
                    zlevelList[i] < zlevel
                    && zlevelList[i + 1] > zlevel
                ) {
                    break;
                }
            }
            prevLayer = layersMap[zlevelList[i]];
        }
        zlevelList.splice(i + 1, 0, zlevel);

        layersMap[zlevel] = layer;

        if (!layer.virtual) {
            if (prevLayer) {
                const prevDom = prevLayer.dom;
                if (prevDom.nextSibling) {
                    domRoot.insertBefore(
                        layer.dom,
                        prevDom.nextSibling
                    );
                }
                else {
                    domRoot.appendChild(layer.dom);
                }
            }
            else {
                if (domRoot.firstChild) {
                    domRoot.insertBefore(layer.dom, domRoot.firstChild);
                }
                else {
                    domRoot.appendChild(layer.dom);
                }
            }
        }

        layer.painter || (layer.painter = this);
    }

    eachLayer<T>(cb: (this: T, layer: Layer, z: number) => void, context?: T) {
        const zlevelList = this._zlevelList;
        for (let i = 0; i < zlevelList.length; i++) {
            const z = zlevelList[i];
            cb.call(context, this._layers[z], z);
        }
    }

    eachBuiltinLayer<T>(cb: (this: T, layer: Layer, z: number) => void, context?: T) {
        const zlevelList = this._zlevelList;
        for (let i = 0; i < zlevelList.length; i++) {
            const z = zlevelList[i];
            const layer = this._layers[z];
            if (layer.__builtin__) {
                cb.call(context, layer, z);
            }
        }
    }

    eachOtherLayer<T>(cb: (this: T, layer: Layer, z: number) => void, context?: T) {
        const zlevelList = this._zlevelList;
        for (let i = 0; i < zlevelList.length; i++) {
            const z = zlevelList[i];
            const layer = this._layers[z];
            if (!layer.__builtin__) {
                cb.call(context, layer, z);
            }
        }
    }

    getLayers() {
        return this._layers;
    }

    _updateLayerStatus(list: Displayable[]) {

        this.eachBuiltinLayer(function (layer, z) {
            layer.__dirty = layer.__used = false;
        });

        function updatePrevLayer(idx: number) {
            if (prevLayer) {
                if (prevLayer.__endIndex !== idx) {
                    prevLayer.__dirty = true;
                }
                prevLayer.__endIndex = idx;
            }
        }

        if (this._singleCanvas) {
            for (let i = 1; i < list.length; i++) {
                const el = list[i];
                if (el.zlevel !== list[i - 1].zlevel || el.incremental) {
                    this._needsManuallyCompositing = true;
                    break;
                }
            }
        }

        let prevLayer: Layer = null;
        let incrementalLayerCount = 0;
        let prevZlevel;
        let i;

        for (i = 0; i < list.length; i++) {
            const el = list[i];
            const zlevel = el.zlevel;
            let layer;

            if (prevZlevel !== zlevel) {
                prevZlevel = zlevel;
                incrementalLayerCount = 0;
            }

            if (el.incremental) {
                layer = this.getLayer(zlevel + INCREMENTAL_INC, this._needsManuallyCompositing);
                layer.incremental = true;
                incrementalLayerCount = 1;
            }
            else {
                layer = this.getLayer(
                    zlevel + (incrementalLayerCount > 0 ? EL_AFTER_INCREMENTAL_INC : 0),
                    this._needsManuallyCompositing
                );
            }

            if (!layer.__builtin__) {
                util.logError('ZLevel ' + zlevel + ' has been used by unkown layer ' + layer.id);
            }

            if (layer !== prevLayer) {
                layer.__used = true;
                if (layer.__startIndex !== i) {
                    layer.__dirty = true;
                }
                layer.__startIndex = i;
                if (!layer.incremental) {
                    layer.__drawIndex = i;
                }
                else {
                    layer.__drawIndex = -1;
                }
                updatePrevLayer(i);
                prevLayer = layer;
            }
            if ((el.__dirty & REDRAW_BIT) && !el.__inHover) {
                layer.__dirty = true;
                if (layer.incremental && layer.__drawIndex < 0) {
                    layer.__drawIndex = i;
                }
            }
        }

        updatePrevLayer(i);

        this.eachBuiltinLayer(function (layer, z) {
            if (!layer.__used && layer.getElementCount() > 0) {
                layer.__dirty = true;
                layer.__startIndex = layer.__endIndex = layer.__drawIndex = 0;
            }
            if (layer.__dirty && layer.__drawIndex < 0) {
                layer.__drawIndex = layer.__startIndex;
            }
        });
    }

    clear() {
        this.eachBuiltinLayer(this._clearLayer);
        return this;
    }

    _clearLayer(layer: Layer) {
        layer.clear();
    }

    setBackgroundColor(backgroundColor: string | GradientObject | ImagePatternObject) {
        this._backgroundColor = backgroundColor;

        util.each(this._layers, layer => {
            layer.setUnpainted();
        });
    }

    configLayer(zlevel: number, config: LayerConfig) {
        if (config) {
            const layerConfig = this._layerConfig;
            if (!layerConfig[zlevel]) {
                layerConfig[zlevel] = config;
            }
            else {
                util.merge(layerConfig[zlevel], config, true);
            }

            for (let i = 0; i < this._zlevelList.length; i++) {
                const _zlevel = this._zlevelList[i];
                if (_zlevel === zlevel || _zlevel === zlevel + EL_AFTER_INCREMENTAL_INC) {
                    const layer = this._layers[_zlevel];
                    util.merge(layer, layerConfig[zlevel], true);
                }
            }
        }
    }

    delLayer(zlevel: number) {
        const layers = this._layers;
        const zlevelList = this._zlevelList;
        const layer = layers[zlevel];
        if (!layer) {
            return;
        }
        layer.dom.parentNode.removeChild(layer.dom);
        delete layers[zlevel];

        zlevelList.splice(util.indexOf(zlevelList, zlevel), 1);
    }

    resize(
        width?: number | string,
        height?: number | string
    ) {
        if (!this._domRoot.style) {
            if (width == null || height == null) {
                return;
            }
            this._width = width as number;
            this._height = height as number;

            this.getLayer(CANVAS_ZLEVEL).resize(width as number, height as number);
        }
        else {
            const domRoot = this._domRoot;
            domRoot.style.display = 'none';

            const opts = this._opts;
            const root = this.root;
            width != null && (opts.width = width);
            height != null && (opts.height = height);

            width = getSize(root, 0, opts);
            height = getSize(root, 1, opts);

            domRoot.style.display = '';

            if (this._width !== width || height !== this._height) {
                domRoot.style.width = width + 'px';
                domRoot.style.height = height + 'px';

                for (let id in this._layers) {
                    if (this._layers.hasOwnProperty(id)) {
                        this._layers[id].resize(width, height);
                    }
                }

                this.refresh(true);
            }

            this._width = width;
            this._height = height;

        }
        return this;
    }

    clearLayer(zlevel: number) {
        const layer = this._layers[zlevel];
        if (layer) {
            layer.clear();
        }
    }

    dispose() {
        this.root.innerHTML = '';

        this.root =
        this.storage =

        this._domRoot =
        this._layers = null;
    }

    getRenderedCanvas(opts?: {
        backgroundColor?: string | GradientObject | ImagePatternObject
        pixelRatio?: number
    }) {
        opts = opts || {};
        if (this._singleCanvas && !this._compositeManually) {
            return this._layers[CANVAS_ZLEVEL].dom;
        }

        const imageLayer = new Layer('image', this, opts.pixelRatio || this.dpr);
        imageLayer.initContext();
        imageLayer.clear(false, opts.backgroundColor || this._backgroundColor);

        const ctx = imageLayer.ctx;

        if (opts.pixelRatio <= this.dpr) {
            this.refresh();

            const width = imageLayer.dom.width;
            const height = imageLayer.dom.height;
            this.eachLayer(function (layer) {
                if (layer.__builtin__) {
                    ctx.drawImage(layer.dom, 0, 0, width, height);
                }
                else if (layer.renderToCanvas) {
                    ctx.save();
                    layer.renderToCanvas(ctx);
                    ctx.restore();
                }
            });
        }
        else {
            const scope = {
                inHover: false,
                viewWidth: this._width,
                viewHeight: this._height
            };
            const displayList = this.storage.getDisplayList(true);
            for (let i = 0, len = displayList.length; i < len; i++) {
                const el = displayList[i];
                brush(ctx, el, scope, i === len - 1);
            }
        }

        return imageLayer.dom;
    }

    getWidth() {
        return this._width;
    }

    getHeight() {
        return this._height;
    }
};
