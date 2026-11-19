# Review before pushing

For changes to Workspace, use an implementer and an independent code reviewer. When the change affects the interface, also assign an independent UI reviewer.

- The implementer makes the change, checks the affected behavior and reports what to review.
- The code reviewer reads the actual diff, checks correctness and regressions, and reports findings or approval.
- The UI reviewer opens the affected screens with the real components and styles, checks desktop and mobile layouts, and exercises the changed interactions. Compare them with neighboring Workspace screens. Include screenshots of the reviewed version and describe any state that could not be checked.

Resolve findings and have the relevant reviewer recheck the final changes before pushing. Report the review results and checks performed.
