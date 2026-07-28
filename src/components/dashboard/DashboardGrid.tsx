"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import GridLayout, {
  useContainerWidth,
  verticalCompactor,
  type Layout,
} from "react-grid-layout";
import { Button } from "@/components/ui/button";
import {
  DEFAULT_DASHBOARD_LAYOUT,
  mergeWithDefaultLayout,
  type DashboardLayoutItem,
} from "@/lib/dashboard-layout";
import { GripVertical, RotateCcw } from "lucide-react";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";

interface Props {
  children: Record<string, React.ReactNode>;
}

export function DashboardGrid({ children }: Props) {
  const { width, containerRef, mounted } = useContainerWidth();
  const [layout, setLayout] = useState<DashboardLayoutItem[]>(
    DEFAULT_DASHBOARD_LAYOUT
  );
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipNextSave = useRef(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/settings/dashboard-layout");
        if (res.ok) {
          const data = await res.json();
          if (!cancelled) {
            skipNextSave.current = true;
            setLayout(mergeWithDefaultLayout(data.layout));
          }
        }
      } catch {
        // デフォルトのまま
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const persist = useCallback(async (next: Layout) => {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/settings/dashboard-layout", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ layout: next }),
      });
      if (!res.ok) {
        setMessage("レイアウトの保存に失敗しました");
        return;
      }
      setMessage("レイアウトを保存しました");
      setTimeout(() => setMessage(null), 1800);
    } catch {
      setMessage("レイアウトの保存に失敗しました");
    } finally {
      setSaving(false);
    }
  }, []);

  const scheduleSave = useCallback(
    (next: Layout) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        void persist(next);
      }, 500);
    },
    [persist]
  );

  const onLayoutChange = useCallback(
    (next: Layout) => {
      setLayout([...next]);
      if (skipNextSave.current) {
        skipNextSave.current = false;
        return;
      }
      scheduleSave(next);
    },
    [scheduleSave]
  );

  const resetLayout = async () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSaving(true);
    try {
      const res = await fetch("/api/settings/dashboard-layout", {
        method: "DELETE",
      });
      const data = res.ok
        ? await res.json()
        : { layout: DEFAULT_DASHBOARD_LAYOUT };
      skipNextSave.current = true;
      setLayout(mergeWithDefaultLayout(data.layout));
      setMessage("初期レイアウトに戻しました");
      setTimeout(() => setMessage(null), 1800);
    } catch {
      setMessage("リセットに失敗しました");
    } finally {
      setSaving(false);
    }
  };

  const items = useMemo(
    () =>
      layout
        .map((item) => ({
          id: item.i,
          node: children[item.i],
        }))
        .filter((x) => x.node != null),
    [layout, children]
  );

  if (!ready) {
    return (
      <div className="flex h-40 items-center justify-center text-gray-400">
        レイアウトを読み込み中...
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-gray-500">
          各ブロック左上のハンドルをドラッグして並び替え、右下でリサイズできます。配置はサーバーに保存されます。
        </p>
        <div className="flex items-center gap-2">
          {message && (
            <span className="text-xs text-gray-500">{message}</span>
          )}
          {saving && (
            <span className="text-xs text-indigo-600">保存中...</span>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={resetLayout}
            disabled={saving}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            レイアウトをリセット
          </Button>
        </div>
      </div>

      <div ref={containerRef} className="w-full">
        {mounted && (
          <GridLayout
            className="dashboard-grid layout"
            layout={layout}
            width={width}
            gridConfig={{
              cols: 12,
              rowHeight: 28,
              margin: [16, 16],
              containerPadding: [0, 0],
            }}
            dragConfig={{
              enabled: true,
              handle: ".dashboard-drag-handle",
            }}
            resizeConfig={{ enabled: true }}
            compactor={verticalCompactor}
            onLayoutChange={onLayoutChange}
          >
            {items.map(({ id, node }) => (
              <div key={id} className="relative h-full">
                <div className="dashboard-drag-handle absolute left-2 top-2 z-20 flex h-8 w-8 cursor-grab items-center justify-center rounded-md bg-white/90 text-gray-400 shadow-sm hover:bg-gray-100 hover:text-gray-700 active:cursor-grabbing">
                  <GripVertical className="h-4 w-4" aria-hidden />
                  <span className="sr-only">ドラッグして移動</span>
                </div>
                <div className="h-full min-h-0 [&_>_*]:h-full">{node}</div>
              </div>
            ))}
          </GridLayout>
        )}
      </div>
    </div>
  );
}
