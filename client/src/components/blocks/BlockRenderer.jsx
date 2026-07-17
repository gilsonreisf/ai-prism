import ChartBlock from './ChartBlock.jsx'
import TableBlock from './TableBlock.jsx'
import InsightCard from './InsightCard.jsx'
import DeckBlock from './DeckBlock.jsx'
import DeckQuestionsBlock from './DeckQuestionsBlock.jsx'
import SpreadsheetBlock from './SpreadsheetBlock.jsx'

const RENDERERS = {
  chart: ChartBlock,
  table: TableBlock,
  insight: InsightCard,
  deck: DeckBlock,
  'deck-questions': DeckQuestionsBlock,
  spreadsheet: SpreadsheetBlock,
}

export default function BlockRenderer({ blocks, onOpenDeck, onOpenSpreadsheet, isLatest, onSubmitAnswers }) {
  if (!blocks?.length) return null
  return (
    <div>
      {blocks.map((b, i) => {
        const Cmp = RENDERERS[b.type]
        return Cmp ? <Cmp key={i} block={b} onOpenDeck={onOpenDeck} onOpenSpreadsheet={onOpenSpreadsheet} isLatest={isLatest} onSubmitAnswers={onSubmitAnswers} /> : null
      })}
    </div>
  )
}
