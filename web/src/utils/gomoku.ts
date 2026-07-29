// 五子棋棋盘逻辑（15×15，纯函数，两端各自校验）。

export const GOMOKU_SIZE = 15

/** 落子后从该点判断是否连五；返回获胜连线的所有格子下标，未胜返回 null。 */
export function gomokuWinLine(cells: readonly number[], idx: number): number[] | null {
  const color = cells[idx]
  if (!color) return null
  const x = idx % GOMOKU_SIZE
  const y = Math.floor(idx / GOMOKU_SIZE)
  const dirs: [number, number][] = [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1],
  ]
  for (const [dx, dy] of dirs) {
    const line = [idx]
    for (const sign of [1, -1]) {
      for (let k = 1; k < 5; k++) {
        const nx = x + dx * k * sign
        const ny = y + dy * k * sign
        if (nx < 0 || nx >= GOMOKU_SIZE || ny < 0 || ny >= GOMOKU_SIZE) break
        const ni = ny * GOMOKU_SIZE + nx
        if (cells[ni] !== color) break
        line.push(ni)
      }
    }
    if (line.length >= 5) return line.sort((a, b) => a - b)
  }
  return null
}
