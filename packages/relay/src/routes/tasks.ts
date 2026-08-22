import { Router, type RequestHandler } from "express";
import type { RelayStore } from "../lib/store.js";

type PairingParams = { id: string };
type TaskParams = PairingParams & { taskId: string };

export function tasksRouter(store: RelayStore): Router {
  const router = Router({ mergeParams: true });

  // GET /pairings/:id/tasks — the shared task board: every task, addressable
  // and attributed, independent of what the current plan text says.
  const list: RequestHandler<PairingParams> = (req, res) => {
    res.json({ tasks: store.getTasks(req.params.id) });
  };

  // POST /pairings/:id/tasks — propose a new task, optionally pre-assigned
  // with a rationale. Not gated behind plan-style consent (see store.ts) —
  // it's recorded to the audit trail, which is the durable "why" record.
  const propose: RequestHandler<PairingParams> = (req, res) => {
    const task = store.proposeTask(req.params.id, req.inzoAuth!.agentId, req.body ?? {});
    res.status(201).json({ task });
  };

  // PUT /pairings/:id/tasks/:taskId/assign — assign or reassign, with a
  // required-in-spirit rationale so "why this owner" survives in the audit log.
  const assign: RequestHandler<TaskParams> = (req, res) => {
    const task = store.assignTask(req.params.id, req.inzoAuth!.agentId, req.params.taskId, req.body ?? {});
    res.json({ task });
  };

  // PUT /pairings/:id/tasks/:taskId/status
  const setStatus: RequestHandler<TaskParams> = (req, res) => {
    const task = store.updateTaskStatus(req.params.id, req.inzoAuth!.agentId, req.params.taskId, req.body?.status);
    res.json({ task });
  };

  router.get("/", list);
  router.post("/", propose);
  router.put("/:taskId/assign", assign);
  router.put("/:taskId/status", setStatus);

  return router;
}
