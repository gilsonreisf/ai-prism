import ChartBlock from './ChartBlock.jsx'
import TableBlock from './TableBlock.jsx'
import InsightCard from './InsightCard.jsx'
import DeckBlock from './DeckBlock.jsx'
import DeckQuestionsBlock from './DeckQuestionsBlock.jsx'
import SpreadsheetBlock from './SpreadsheetBlock.jsx'
import ImageBlock from './ImageBlock.jsx'
import DocumentBlock from './DocumentBlock.jsx'

const RENDERERS = {
  chart: ChartBlock,
  table: TableBlock,
  insight: InsightCard,
  deck: DeckBlock,
  'deck-questions': DeckQuestionsBlock,
  spreadsheet: SpreadsheetBlock,
  image: ImageBlock,
  document: DocumentBlock,
}

export default function BlockRenderer({ blocks, msgId, models, onOpenDeck, onOpenSpreadsheet, onOpenDocument, isLatest, onSubmitAnswers }) {
  if (!blocks?.length) return null
  return (
    <div>
      {blocks.map((b, i) => {
        const Cmp = RENDERERS[b.type]
        return Cmp ? (
          <Cmp
            key={i}
            block={b}
            msgId={msgId}
            models={models}
            onOpenDeck={onOpenDeck}
            onOpenSpreadsheet={onOpenSpreadsheet}
            onOpenDocument={onOpenDocument}
            isLatest={isLatest}
            onSubmitAnswers={onSubmitAnswers}
          />
        ) : null
      })}
    </div>
  )
}
