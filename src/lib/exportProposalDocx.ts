import { AlignmentType, Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from 'docx'
import type { Proposal, ProposalLineItem } from './types'

// Client-facing export only -- deliberately never touches unit_cost, margin_pct,
// ai_raw_response, or internal notes. Only description/quantity/unit_price/total.

function money(n: number): string {
  return `$${n.toFixed(2)}`
}

function kindLabel(kind: string): string {
  if (kind === 'labor') return 'Labor'
  if (kind === 'part') return 'Part'
  return 'Other'
}

function cell(text: string, alignment: (typeof AlignmentType)[keyof typeof AlignmentType] = AlignmentType.LEFT): TableCell {
  return new TableCell({ children: [new Paragraph({ text, alignment })] })
}

function headerCell(text: string, alignment: (typeof AlignmentType)[keyof typeof AlignmentType] = AlignmentType.LEFT): TableCell {
  return new TableCell({
    shading: { fill: 'EEEEEE' },
    children: [new Paragraph({ alignment, children: [new TextRun({ text, bold: true })] })],
  })
}

export async function exportProposalDocx(proposal: Proposal, lineItems: ProposalLineItem[]): Promise<Blob> {
  const itemRows = lineItems.map((li) => {
    const total = li.quantity * li.unit_price
    return new TableRow({
      children: [
        cell(kindLabel(li.kind)),
        cell(li.description || '—'),
        cell(String(li.quantity)),
        cell(money(li.unit_price), AlignmentType.RIGHT),
        cell(money(total), AlignmentType.RIGHT),
      ],
    })
  })

  const grandTotal = lineItems.reduce((s, li) => s + li.quantity * li.unit_price, 0)

  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: 'New Global Vista Solutions', heading: HeadingLevel.HEADING_2 }),
          new Paragraph({ text: 'Service Proposal', heading: HeadingLevel.TITLE }),
          new Paragraph({ text: `Work Order: ${proposal.wo}` }),
          new Paragraph({ text: `Date: ${new Date(proposal.updated_at).toLocaleDateString()}` }),
          new Paragraph({ text: '' }),

          new Paragraph({ text: 'Scope of Work', heading: HeadingLevel.HEADING_3 }),
          new Paragraph({ text: proposal.narrative_scope || '—' }),
          new Paragraph({ text: '' }),

          new Paragraph({ text: 'Findings', heading: HeadingLevel.HEADING_3 }),
          new Paragraph({ text: proposal.narrative_findings || '—' }),
          new Paragraph({ text: '' }),

          new Paragraph({ text: 'Recommendation', heading: HeadingLevel.HEADING_3 }),
          new Paragraph({ text: proposal.narrative_recommendation || '—' }),
          new Paragraph({ text: '' }),

          new Paragraph({ text: 'Itemized Estimate', heading: HeadingLevel.HEADING_3 }),
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [
              new TableRow({
                children: [
                  headerCell('Type'),
                  headerCell('Description'),
                  headerCell('Qty'),
                  headerCell('Unit Price', AlignmentType.RIGHT),
                  headerCell('Total', AlignmentType.RIGHT),
                ],
              }),
              ...itemRows,
            ],
          }),
          new Paragraph({ text: '' }),
          new Paragraph({
            alignment: AlignmentType.RIGHT,
            children: [new TextRun({ text: `Total: ${money(grandTotal)}`, bold: true })],
          }),
          new Paragraph({ text: '' }),

          new Paragraph({ text: 'Terms', heading: HeadingLevel.HEADING_3 }),
          new Paragraph({ text: proposal.terms || '—' }),
        ],
      },
    ],
  })

  return Packer.toBlob(doc)
}
