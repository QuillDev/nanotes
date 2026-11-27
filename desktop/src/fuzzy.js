// Fuzzy note search: every whitespace-separated word of the query must appear in order
// (case-insensitive) in the text. Contiguous runs and word starts score higher.

const isBoundary = (text, index) => index === 0 || /[\s\-_./()#]/.test(text[index - 1])

function atomScore(atom, text) {
  let best = null
  // Try each start position of the first character and keep the best greedy match.
  for (let start = text.indexOf(atom[0]); start !== -1; start = text.indexOf(atom[0], start + 1)) {
    let score = 0
    let at = start
    let previous = -2
    for (let i = 0; i < atom.length; i += 1) {
      at = i === 0 ? start : text.indexOf(atom[i], previous + 1)
      if (at === -1) return best
      score += 1
      if (at === previous + 1) score += 4
      if (isBoundary(text, at)) score += 3
      previous = at
    }
    score -= Math.min(start, 200) / 100
    if (best === null || score > best) best = score
  }
  return best
}

/** Score of `query` against `text`, or null when any query word doesn't match. */
export function fuzzyScore(query, text) {
  const haystack = text.toLowerCase()
  let total = 0
  for (const atom of query.toLowerCase().split(/\s+/).filter(Boolean)) {
    const score = atomScore(atom, haystack)
    if (score === null) return null
    total += score
  }
  return total
}
