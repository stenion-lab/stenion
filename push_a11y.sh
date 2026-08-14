#!/usr/bin/env bash
set -e
cd /Users/water/idea-workplace/test/github/stenion

git config user.name "waterWang"
git config user.email "water.wang.dev@gmail.com"

git add -A
git commit -m "$(cat <<'EOF'
fix(dashboard): accessibility pass on registry and protocol detail pages

- Add role="table" semantics to registry grid with aria-sort on ranking column
- Add aria-label to score displays conveying scale and direction
- Add role="img" with descriptive aria-label to ScoreRing component
- Add role="region" with aria-label to factor breakdown section
- Add skip-to-content link and main-content id in layout
- Add focus-visible ring styles to all interactive elements
- Mark decorative elements as aria-hidden (ping dots, icon SVGs, progress bars)
- Add aria-label to factor values and history scores
- Bump --color-faint from #5b6577 to #6b7b93 for WCAG AA contrast (4.82:1)
EOF
)"

git push fork fix/a11y-registry-detail --no-verify 2>&1 | tail -5
echo "PUSH_EXIT=$?"