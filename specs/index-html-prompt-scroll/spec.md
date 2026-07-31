# Spec: Fix index.html Prompt Cutoff

Status: completed

## Requirement

Fix `web/index.html` so the prompt text in the detail panel is not cut off; display the full prompt with scroll.

## Solution

Override `max-height` and `overflow` on `.detail-box.prompt` to remove the inherited 160px height cap, allowing the full prompt to render inside the scrollable `.detail-body` panel.
