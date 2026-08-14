/**
 * LayersPanel.jsx — layer list for Campaign Design Studio 2.0.
 * Top of list = visually front-most (arrays render bottom-up).
 * Row actions: visibility, lock; context row buttons: duplicate, delete,
 * move up/down. Selecting a row selects the layer on canvas (keyboard-
 * accessible path per accessibility guidelines).
 */
import {
  Eye, EyeOff, Lock, Unlock, Copy, Trash2, ChevronUp, ChevronDown,
  Image as ImageIcon, Type as TypeIcon, Component, Sparkles as SparklesIcon, Wallpaper,
} from "lucide-react";

const TYPE_ICON = {
  background: Wallpaper,
  image: ImageIcon,
  text: TypeIcon,
  component: Component,
  effect: SparklesIcon,
};

function typeCaption(layer) {
  if (layer.type === "image") return layer.role === "poster" ? "Poster" : layer.role === "decor" ? "Decor" : "Hero";
  if (layer.type === "component") return layer.componentId;
  if (layer.type === "effect") return layer.effectId;
  return layer.type;
}

export default function LayersPanel({ state, dispatch }) {
  const { canvas, selectedId } = state;
  const rows = [...canvas.layers].reverse(); // front-most first

  return (
    <div className="flex flex-col gap-1" data-testid="layers-panel">
      {rows.map((layer) => {
        const Icon = TYPE_ICON[layer.type] || ImageIcon;
        const isSel = layer.id === selectedId;
        const isBg = layer.type === "background";
        return (
          <div
            key={layer.id}
            role="button"
            tabIndex={0}
            onClick={() => dispatch({ type: "SELECT", id: layer.id })}
            onKeyDown={(e) => { if (e.key === "Enter") dispatch({ type: "SELECT", id: layer.id }); }}
            className="group flex items-center gap-2 rounded-xl px-2 py-2 cursor-pointer transition-colors"
            style={{
              background: isSel ? "rgba(212,168,67,0.14)" : "transparent",
              border: isSel ? "1px solid rgba(212,168,67,0.3)" : "1px solid transparent",
              opacity: layer.visible === false ? 0.45 : 1,
            }}
            data-testid={`layers-panel-row-${layer.id}`}
          >
            <span className="grid place-items-center h-8 w-8 rounded-lg shrink-0" style={{ background: "rgba(45,31,62,0.6)", border: "1px solid rgba(212,168,67,0.18)" }}>
              <Icon className="h-3.5 w-3.5 text-gold" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[12px] font-semibold text-parchment truncate">{layer.name || layer.type}</p>
              <p className="text-[9.5px] uppercase tracking-wider text-faded">{typeCaption(layer)}</p>
            </div>

            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity" style={{ opacity: isSel ? 1 : undefined }}>
              {!isBg && (
                <>
                  <button type="button" aria-label="Move layer up" title="Bring forward"
                          onClick={(e) => { e.stopPropagation(); dispatch({ type: "REORDER_LAYER", id: layer.id, direction: "up" }); }}
                          className="grid place-items-center h-6 w-6 rounded-md text-faded hover:text-gold"
                          data-testid={`layers-panel-up-${layer.id}`}>
                    <ChevronUp className="h-3.5 w-3.5" />
                  </button>
                  <button type="button" aria-label="Move layer down" title="Send backward"
                          onClick={(e) => { e.stopPropagation(); dispatch({ type: "REORDER_LAYER", id: layer.id, direction: "down" }); }}
                          className="grid place-items-center h-6 w-6 rounded-md text-faded hover:text-gold"
                          data-testid={`layers-panel-down-${layer.id}`}>
                    <ChevronDown className="h-3.5 w-3.5" />
                  </button>
                  <button type="button" aria-label="Duplicate layer" title="Duplicate"
                          onClick={(e) => { e.stopPropagation(); dispatch({ type: "DUPLICATE_LAYER", id: layer.id }); }}
                          className="grid place-items-center h-6 w-6 rounded-md text-faded hover:text-gold"
                          data-testid={`layers-panel-duplicate-${layer.id}`}>
                    <Copy className="h-3.5 w-3.5" />
                  </button>
                </>
              )}
              <button type="button" aria-label="Toggle visibility" title="Show / hide"
                      onClick={(e) => { e.stopPropagation(); dispatch({ type: "UPDATE_LAYER", id: layer.id, patch: { visible: layer.visible === false } }); }}
                      className="grid place-items-center h-6 w-6 rounded-md text-faded hover:text-gold"
                      data-testid={`layers-panel-visibility-${layer.id}`}>
                {layer.visible === false ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
              {!isBg && (
                <>
                  <button type="button" aria-label="Toggle lock" title="Lock / unlock"
                          onClick={(e) => { e.stopPropagation(); dispatch({ type: "UPDATE_LAYER", id: layer.id, patch: { locked: !layer.locked } }); }}
                          className="grid place-items-center h-6 w-6 rounded-md text-faded hover:text-gold"
                          data-testid={`layers-panel-lock-${layer.id}`}>
                    {layer.locked ? <Lock className="h-3.5 w-3.5 text-gold" /> : <Unlock className="h-3.5 w-3.5" />}
                  </button>
                  <button type="button" aria-label="Delete layer" title="Delete"
                          onClick={(e) => { e.stopPropagation(); dispatch({ type: "REMOVE_LAYER", id: layer.id }); }}
                          className="grid place-items-center h-6 w-6 rounded-md text-faded hover:text-red-300"
                          data-testid={`layers-panel-delete-${layer.id}`}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
