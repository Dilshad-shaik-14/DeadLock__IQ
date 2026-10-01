import React, { useEffect, useMemo } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  Node,
  Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { TransactionNode, ResourceNode } from './FlowNodes.tsx';
import { GraphSnapshot } from '../types/index.ts';
import { AlertTriangle, Layers, Info } from 'lucide-react';
import { ErrorBoundary } from './ErrorBoundary.tsx';

interface WaitForGraphViewProps {
  snapshot: GraphSnapshot | null;
  onNodeClick: (nodeId: string) => void;
}

const WaitForGraphViewInner: React.FC<WaitForGraphViewProps> = ({
  snapshot,
  onNodeClick,
}) => {
  const nodeTypes = useMemo(
    () => ({
      transactionNode: TransactionNode,
      resourceNode: ResourceNode,
    }),
    []
  );

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  useEffect(() => {
    if (!snapshot || !Array.isArray(snapshot.nodes)) {
      setNodes([]);
      setEdges([]);
      return;
    }

    const validNodeIdSet = new Set<string>();
    const flowNodes: Node[] = [];

    for (const n of snapshot.nodes) {
      if (n && n.id) {
        validNodeIdSet.add(n.id);
        flowNodes.push({
          id: n.id,
          type: n.type || 'transactionNode',
          position: n.position || { x: 300, y: 200 },
          data: n.data || { id: n.id, label: n.id, nodeType: 'transaction' },
        });
      }
    }

    const rawEdges = Array.isArray(snapshot.edges) ? snapshot.edges : [];
    const flowEdges: Edge[] = [];

    for (const e of rawEdges) {
      // Validate both endpoints exist in nodes to prevent React Flow crashes
      if (e && e.id && validNodeIdSet.has(e.source) && validNodeIdSet.has(e.target)) {
        flowEdges.push({
          id: e.id,
          source: e.source,
          target: e.target,
          label: e.label || '',
          animated: !!e.animated,
          style: e.style || {},
          data: e.data || { id: e.id, source: e.source, target: e.target, edgeType: 'holds', isCycle: false },
        });
      }
    }

    setNodes(flowNodes);
    setEdges(flowEdges);
  }, [snapshot, setNodes, setEdges]);

  const hasCycles = (snapshot?.activeCycles?.length ?? 0) > 0;
  const cycleCount = snapshot?.activeCycles?.length ?? 0;

  return (
    <div className="relative w-full h-[520px] bg-slate-950 rounded-xl border border-slate-800 shadow-2xl overflow-hidden flex flex-col">
      {/* Top Banner */}
      <div className="absolute top-3 left-3 z-10 flex flex-wrap items-center gap-2">
        <div className="bg-slate-900/90 backdrop-blur px-3 py-1.5 rounded-lg border border-slate-800 shadow-lg flex items-center gap-2 text-xs font-mono">
          <span className="w-2 h-2 rounded-full bg-sky-400"></span>
          <span className="text-slate-200 font-bold">Wait-For Graph (WFG)</span>
          <span className="text-slate-500">|</span>
          <span className="text-slate-400">
            {nodes.length} Nodes • {edges.length} Edges
          </span>
        </div>

        {hasCycles && (
          <div className="bg-red-950/90 backdrop-blur border border-red-500/80 px-3 py-1.5 rounded-lg text-xs font-mono font-bold text-red-200 shadow-lg shadow-red-950/50 flex items-center gap-1.5 animate-pulse">
            <AlertTriangle className="w-3.5 h-3.5 text-red-400" />
            <span>
              ACTIVE DEADLOCK DETECTED ({cycleCount} {cycleCount === 1 ? 'CYCLE' : 'CYCLES'})
            </span>
          </div>
        )}
      </div>

      {/* Legend */}
      <div className="absolute top-3 right-3 z-10 hidden sm:flex items-center gap-2 bg-slate-900/90 backdrop-blur px-3 py-1.5 rounded-lg border border-slate-800 text-[10px] font-mono text-slate-300">
        <div className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
          <span>Holds Lock</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-amber-400"></span>
          <span>Waiting</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse"></span>
          <span>Deadlock Cycle</span>
        </div>
      </div>

      {nodes.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center p-6 text-slate-500 font-mono text-xs">
          <Layers className="w-8 h-8 text-slate-600 mb-2 animate-bounce" />
          <p className="text-slate-400 font-semibold mb-1">Graph Canvas Initialized</p>
          <p className="text-slate-600 max-w-xs">
            Launch a scenario below (e.g. 2-Way or 3-Way Deadlock) to populate concurrent workers, lock leases, and dependency edges.
          </p>
        </div>
      ) : (
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodeTypes={nodeTypes}
          onNodeClick={(_, node) => onNodeClick(node.id)}
          fitView
          fitViewOptions={{ padding: 0.25 }}
          minZoom={0.2}
          maxZoom={1.8}
          proOptions={{ hideAttribution: true }}
        >
          <Background color="#1e293b" gap={20} size={1} />
          <Controls showInteractive={false} className="!bg-slate-900 !border-slate-800" />
          <MiniMap
            nodeColor={n => (n.type === 'transactionNode' ? '#38bdf8' : '#10b981')}
            maskColor="rgba(15, 23, 42, 0.7)"
            className="!bg-slate-900 !border-slate-800 !rounded-lg overflow-hidden"
          />
        </ReactFlow>
      )}
    </div>
  );
};

export const WaitForGraphView: React.FC<WaitForGraphViewProps> = (props) => {
  return (
    <ErrorBoundary fallbackTitle="Graph Visualization Safeguard">
      <WaitForGraphViewInner {...props} />
    </ErrorBoundary>
  );
};
