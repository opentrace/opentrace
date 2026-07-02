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

import { PresetIcon } from '../components/panels/PresetIcon';
import type { GraphPreset } from '../components/config/graphPresets';

interface ViewPresetBarProps {
  presets: GraphPreset[];
  /** Currently-applied preset id, or null/'custom' when hand-tweaked. */
  activePresetId: string | null;
  onSelectPreset: (id: string) => void;
}

/** Always-visible view switcher floating over the graph's top-right corner —
 *  one click snaps the canvas into a preset look without opening the physics
 *  tuner (where these chips used to hide). */
export default function ViewPresetBar({
  presets,
  activePresetId,
  onSelectPreset,
}: ViewPresetBarProps) {
  return (
    <div className="view-preset-bar" role="group" aria-label="Graph views">
      {presets.map((p) => (
        <button
          key={p.id}
          type="button"
          className={`view-preset-chip${activePresetId === p.id ? ' active' : ''}`}
          title={p.description}
          onClick={() => onSelectPreset(p.id)}
        >
          <PresetIcon name={p.icon} size={15} />
          <span className="view-preset-chip-label">{p.label}</span>
        </button>
      ))}
    </div>
  );
}
