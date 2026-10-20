// A minimal React binding for plain Leaflet (BSD-2-Clause), covering exactly
// what the two map components use. It replaces react-leaflet, whose
// Hippocratic License 2.1 is not OSI-approved and could keep the app out of
// F-Droid. Props follow react-leaflet's names so the call sites are unchanged.
//
// Like react-leaflet, map-level options (center, zoom, bounds, min/max zoom)
// apply once at creation. Popup and Tooltip children render through a portal
// into the element Leaflet shows, so React context (Router links) still works.

import React, { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import L from 'leaflet';
import type { GeoJsonObject } from 'geojson';

const MapContext = createContext<L.Map | null>(null);
// The layer a Popup/Tooltip child binds itself to.
const LayerContext = createContext<L.Layer | null>(null);

interface MapContainerProps {
  center?: L.LatLngExpression;
  zoom?: number;
  bounds?: L.LatLngBoundsExpression;
  boundsOptions?: L.FitBoundsOptions;
  minZoom?: number;
  maxZoom?: number;
  scrollWheelZoom?: boolean;
  style?: React.CSSProperties;
  className?: string;
  children?: React.ReactNode;
}

export function MapContainer({
  center, zoom, bounds, boundsOptions, minZoom, maxZoom, scrollWheelZoom, style, className, children,
}: MapContainerProps) {
  const el = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<L.Map | null>(null);

  useLayoutEffect(() => {
    if (!el.current) return;
    const m = L.map(el.current, { minZoom, maxZoom, scrollWheelZoom });
    if (bounds) m.fitBounds(bounds, boundsOptions);
    else m.setView(center ?? [0, 0], zoom ?? 2);
    setMap(m);
    return () => {
      m.remove();
      setMap(null);
    };
    // Creation-time options only, as in react-leaflet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div ref={el} style={style} className={className}>
      {map && <MapContext.Provider value={map}>{children}</MapContext.Provider>}
    </div>
  );
}

/** Adds `layer` to the map for as long as it is mounted. */
function useAddedLayer(layer: L.Layer | null) {
  const map = useContext(MapContext);
  useEffect(() => {
    if (!map || !layer) return;
    layer.addTo(map);
    return () => {
      layer.remove();
    };
  }, [map, layer]);
}

interface TileLayerProps {
  url: string;
  attribution?: string;
  maxZoom?: number;
  referrerPolicy?: string;
}

export function TileLayer({ url, attribution, maxZoom, referrerPolicy }: TileLayerProps) {
  const layer = useMemo(
    () => L.tileLayer(url, { attribution, maxZoom, referrerPolicy: referrerPolicy as never }),
    [url, attribution, maxZoom, referrerPolicy],
  );
  useAddedLayer(layer);
  return null;
}

type Handlers = Record<string, L.LeafletEventHandlerFn>;

function useHandlers(layer: L.Layer | null, handlers?: Handlers) {
  useEffect(() => {
    if (!layer || !handlers) return;
    layer.on(handlers);
    return () => {
      layer.off(handlers);
    };
  }, [layer, handlers]);
}

interface MarkerProps {
  position: L.LatLngExpression;
  icon?: L.Icon | L.DivIcon;
  zIndexOffset?: number;
  eventHandlers?: Handlers;
  children?: React.ReactNode;
}

export function Marker({ position, icon, zIndexOffset, eventHandlers, children }: MarkerProps) {
  const marker = useMemo(
    () => L.marker(position, { icon, zIndexOffset }),
    // Position and icon changes are applied below without rebuilding, so
    // an open popup survives a re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  useAddedLayer(marker);
  useHandlers(marker, eventHandlers);
  useEffect(() => {
    marker.setLatLng(position);
  }, [marker, position]);
  useEffect(() => {
    if (icon) marker.setIcon(icon);
  }, [marker, icon]);
  useEffect(() => {
    marker.setZIndexOffset(zIndexOffset ?? 0);
  }, [marker, zIndexOffset]);
  return <LayerContext.Provider value={marker}>{children}</LayerContext.Provider>;
}

interface GeoJSONProps {
  data: GeoJsonObject;
  style?: L.PathOptions;
  interactive?: boolean;
  eventHandlers?: Handlers;
  children?: React.ReactNode;
}

export function GeoJSON({ data, style, interactive, eventHandlers, children }: GeoJSONProps) {
  const layer = useMemo(
    () => L.geoJSON(data, { style, interactive }),
    // Rebuilt only when the data changes; style updates go through setStyle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data],
  );
  useAddedLayer(layer);
  useHandlers(layer, eventHandlers);
  useEffect(() => {
    if (style) layer.setStyle(style);
  });
  return <LayerContext.Provider value={layer}>{children}</LayerContext.Provider>;
}

/** A detached element Leaflet can show, with the React children portalled in. */
function useContentElement() {
  return useMemo(() => document.createElement('div'), []);
}

interface PopupProps {
  maxWidth?: number;
  minWidth?: number;
  autoPanPadding?: L.PointExpression;
  children?: React.ReactNode;
}

export function Popup({ maxWidth, minWidth, autoPanPadding, children }: PopupProps) {
  const parent = useContext(LayerContext);
  const content = useContentElement();
  useEffect(() => {
    if (!parent) return;
    parent.bindPopup(content, { maxWidth, minWidth, autoPanPadding: autoPanPadding as L.PointExpression });
    return () => {
      parent.unbindPopup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parent, content]);
  return createPortal(children, content);
}

interface TooltipProps {
  direction?: L.Direction;
  offset?: L.PointExpression;
  children?: React.ReactNode;
}

export function Tooltip({ direction, offset, children }: TooltipProps) {
  const parent = useContext(LayerContext);
  const content = useContentElement();
  useEffect(() => {
    if (!parent) return;
    parent.bindTooltip(content, { direction, offset: offset as L.PointExpression });
    return () => {
      parent.unbindTooltip();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parent, content]);
  // Text is portalled as a React text node, never parsed as HTML, so a region
  // label can't inject markup into the tooltip.
  return createPortal(children, content);
}
