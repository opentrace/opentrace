/*
 * Copyright 2026 OpenTrace Contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { PhysicsPanel, type GraphCanvasHandle } from '@opentrace/components';
import type { Dispatch, RefObject, SetStateAction } from 'react';

type ColorMode = 'type' | 'community';
type LayoutMode = 'spread' | 'compact';

interface PhysicsPanelContainerProps {
  canvasRef: RefObject<GraphCanvasHandle | null>;

  repulsion: number;
  setRepulsion: Dispatch<SetStateAction<number>>;
  labelsVisible: boolean;
  setLabelsVisible: Dispatch<SetStateAction<boolean>>;

  colorMode: ColorMode;
  setColorMode: Dispatch<SetStateAction<ColorMode>>;

  physicsRunning: boolean;
  setPhysicsRunning: Dispatch<SetStateAction<boolean>>;

  pixiLinkDist: number;
  setPixiLinkDist: Dispatch<SetStateAction<number>>;
  pixiCenter: number;
  setPixiCenter: Dispatch<SetStateAction<number>>;
  pixiZoomExponent: number;
  setPixiZoomExponent: Dispatch<SetStateAction<number>>;

  layoutMode: LayoutMode;
  setLayoutMode: Dispatch<SetStateAction<LayoutMode>>;

  compactRadial: number;
  setCompactRadial: Dispatch<SetStateAction<number>>;
  compactCommunity: number;
  setCompactCommunity: Dispatch<SetStateAction<number>>;
  compactCentering: number;
  setCompactCentering: Dispatch<SetStateAction<number>>;
  compactRadius: number;
  setCompactRadius: Dispatch<SetStateAction<number>>;

  mode3d: boolean;
  setMode3d: Dispatch<SetStateAction<boolean>>;
  mode3dSpeed: number;
  setMode3dSpeed: Dispatch<SetStateAction<number>>;
  mode3dTilt: number;
  setMode3dTilt: Dispatch<SetStateAction<number>>;

  rendererAutoRotate: boolean | null;
  setRendererAutoRotate: Dispatch<SetStateAction<boolean | null>>;

  labelScale: number;
  setLabelScale: Dispatch<SetStateAction<number>>;
}

/** Wires PhysicsPanel state changes to the canvas's imperative API. */
export const PhysicsPanelContainer = ({
  canvasRef,
  repulsion,
  setRepulsion,
  labelsVisible,
  setLabelsVisible,
  colorMode,
  setColorMode,
  physicsRunning,
  setPhysicsRunning,
  pixiLinkDist,
  setPixiLinkDist,
  pixiCenter,
  setPixiCenter,
  pixiZoomExponent,
  setPixiZoomExponent,
  layoutMode,
  setLayoutMode,
  compactRadial,
  setCompactRadial,
  compactCommunity,
  setCompactCommunity,
  compactCentering,
  setCompactCentering,
  compactRadius,
  setCompactRadius,
  mode3d,
  setMode3d,
  mode3dSpeed,
  setMode3dSpeed,
  mode3dTilt,
  setMode3dTilt,
  rendererAutoRotate,
  setRendererAutoRotate,
  labelScale,
  setLabelScale,
}: PhysicsPanelContainerProps) => (
  <PhysicsPanel
    repulsion={repulsion}
    onRepulsionChange={(v) => {
      setRepulsion(v);
      canvasRef.current?.setChargeStrength?.(-v);
    }}
    labelsVisible={labelsVisible}
    onLabelsVisibleChange={(v) => {
      setLabelsVisible(v);
      canvasRef.current?.setShowLabels?.(v);
    }}
    colorMode={colorMode}
    onColorModeChange={setColorMode}
    isPhysicsRunning={physicsRunning}
    onStopPhysics={() => {
      canvasRef.current?.stopPhysics();
      setPhysicsRunning(false);
    }}
    onStartPhysics={() => {
      canvasRef.current?.startPhysics();
      setPhysicsRunning(true);
    }}
    pixiMode={true}
    linkDistance={pixiLinkDist}
    onLinkDistanceChange={(v) => {
      setPixiLinkDist(v);
      canvasRef.current?.setLinkDistance?.(v);
    }}
    centerStrength={pixiCenter}
    onCenterStrengthChange={(v) => {
      setPixiCenter(v);
      canvasRef.current?.setCenterStrength?.(v);
    }}
    layoutMode={layoutMode}
    onLayoutModeChange={(mode) => {
      setLayoutMode(mode);
      canvasRef.current?.setLayoutMode?.(mode);
    }}
    radialStrength={compactRadial}
    onRadialStrengthChange={(v) => {
      setCompactRadial(v);
      canvasRef.current?.updateCompactConfig?.({ radialStrength: v / 100 });
    }}
    communityPull={compactCommunity}
    onCommunityPullChange={(v) => {
      setCompactCommunity(v);
      canvasRef.current?.updateCompactConfig?.({ communityPull: v / 100 });
    }}
    centeringStrength={compactCentering}
    onCenteringStrengthChange={(v) => {
      setCompactCentering(v);
      canvasRef.current?.updateCompactConfig?.({ centeringStrength: v / 100 });
    }}
    circleRadius={compactRadius}
    onCircleRadiusChange={(v) => {
      setCompactRadius(v);
      canvasRef.current?.updateCompactConfig?.({ radiusScale: v });
    }}
    zoomSizeExponent={pixiZoomExponent}
    onZoomSizeExponentChange={(v) => {
      setPixiZoomExponent(v);
      canvasRef.current?.setZoomSizeExponent?.(v);
    }}
    onReheat={() => canvasRef.current?.reheat?.()}
    onFitToScreen={() => canvasRef.current?.fitToScreen?.()}
    mode3d={mode3d}
    onMode3dChange={(v) => {
      setMode3d(v);
      canvasRef.current?.set3DMode?.(v);
    }}
    mode3dAutoRotate={mode3d ? (rendererAutoRotate ?? true) : true}
    onMode3dAutoRotateChange={(v) => {
      canvasRef.current?.set3DAutoRotate?.(v);
      setRendererAutoRotate(v);
    }}
    mode3dSpeed={mode3dSpeed}
    onMode3dSpeedChange={(v) => {
      setMode3dSpeed(v);
      canvasRef.current?.set3DSpeed?.(v / 10000);
    }}
    mode3dTilt={mode3dTilt}
    onMode3dTiltChange={(v) => {
      setMode3dTilt(v);
      canvasRef.current?.set3DTilt?.(v / 100);
    }}
    labelScale={labelScale}
    onLabelScaleChange={(v) => {
      setLabelScale(v);
      canvasRef.current?.setLabelScale?.(v / 100);
    }}
  />
);
