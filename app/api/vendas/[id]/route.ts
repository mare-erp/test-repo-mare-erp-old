
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/app/lib/prisma';
import { cookies } from 'next/headers';
import jwt from 'jsonwebtoken';
import { StatusPedido } from '@prisma/client';

interface TokenPayload {
  empresaId: string;
  userId: string;
}

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const cookieStore = cookies();
    const token = cookieStore.get('auth-token')?.value;
    if (!token) return NextResponse.json({ message: 'Não autorizado' }, { status: 401 });

    const { empresaId } = jwt.verify(token, process.env.JWT_SECRET!) as TokenPayload;
    const { id } = params;

    const pedido = await prisma.pedido.findUnique({
      where: { id, empresaId },
      include: {
        cliente: { select: { id: true, nome: true } },
        vendedor: { select: { id: true, nome: true } },
        itens: {
          include: {
            produto: { select: { id: true, nome: true, sku: true, tipo: true } },
          },
        },
      },
    });

    if (!pedido) {
      return NextResponse.json({ message: 'Pedido não encontrado.' }, { status: 404 });
    }

    return NextResponse.json({
      ...pedido,
      valorTotal: Number(pedido.valorTotal),
      itens: pedido.itens.map(item => ({
        ...item,
        precoUnitario: Number(item.precoUnitario),
        subtotal: Number(item.subtotal),
      })),
    });
  } catch (error) {
    console.error('Erro ao buscar pedido:', error);
    return NextResponse.json({ message: 'Erro interno do servidor.' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const cookieStore = cookies();
    const token = cookieStore.get('auth-token')?.value;
    if (!token) return NextResponse.json({ message: 'Não autorizado' }, { status: 401 });

    const { empresaId } = jwt.verify(token, process.env.JWT_SECRET!) as TokenPayload;
    const { id } = params;
    const { clienteId, status, observacoes, itens } = await request.json();

    const existingPedido = await prisma.pedido.findUnique({ where: { id, empresaId } });
    if (!existingPedido) {
      return NextResponse.json({ message: 'Pedido não encontrado.' }, { status: 404 });
    }

    let valorTotal = existingPedido.valorTotal.toNumber();

    // Atualizar itens do pedido se fornecidos
    if (itens && itens.length > 0) {
      // Primeiro, remover itens antigos e reverter estoque
      await prisma.itemPedido.deleteMany({ where: { pedidoId: id } });
      // TODO: Reverter estoque para itens removidos/alterados

      const itensParaCriar = [];
      valorTotal = 0; // Recalcular valor total

      for (const item of itens) {
        const produto = await prisma.produto.findUnique({
          where: { id: item.produtoId, empresaId },
        });

        if (!produto) {
          return NextResponse.json({ error: `Produto com ID ${item.produtoId} não encontrado.` }, { status: 404 });
        }

        const subtotal = produto.preco.toNumber() * item.quantidade;
        valorTotal += subtotal;

        itensParaCriar.push({
          produtoId: produto.id,
          quantidade: item.quantidade,
          precoUnitario: produto.preco,
          subtotal: subtotal,
        });

        // Se for produto, subtrair do estoque (considerando que o estoque anterior foi revertido)
        if (produto.tipo === 'PRODUTO') {
          await prisma.produto.update({
            where: { id: produto.id },
            data: {
              quantidadeEstoque: { decrement: item.quantidade },
            },
          });

          await prisma.movimentacaoEstoque.create({
            data: {
              produtoId: produto.id,
              tipo: 'SAIDA',
              quantidade: item.quantidade,
              observacao: `Venda - Pedido ${clienteId}`,
              empresaId,
            },
          });
        }
      }

      await prisma.itemPedido.createMany({
        data: itensParaCriar.map(item => ({ ...item, pedidoId: id }))
      });
    }

    const updatedPedido = await prisma.pedido.update({
      where: { id, empresaId },
      data: {
        clienteId: clienteId ?? existingPedido.clienteId,
        status: status ?? existingPedido.status,
        observacoesNF: observacoes ?? existingPedido.observacoesNF,
        valorTotal: valorTotal,
      },
    });

    return NextResponse.json({
      ...updatedPedido,
      valorTotal: Number(updatedPedido.valorTotal),
    });
  } catch (error) {
    console.error('Erro ao atualizar pedido:', error);
    return NextResponse.json({ message: 'Erro interno do servidor.' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const cookieStore = cookies();
    const token = cookieStore.get('auth-token')?.value;
    if (!token) return NextResponse.json({ message: 'Não autorizado' }, { status: 401 });

    const { empresaId } = jwt.verify(token, process.env.JWT_SECRET!) as TokenPayload;
    const { id } = params;

    const existingPedido = await prisma.pedido.findUnique({ where: { id, empresaId } });
    if (!existingPedido) {
      return NextResponse.json({ message: 'Pedido não encontrado.' }, { status: 404 });
    }

    // Reverter estoque antes de deletar o pedido e seus itens
    const itensPedido = await prisma.itemPedido.findMany({
      where: { pedidoId: id },
      include: { produto: true },
    });

    for (const item of itensPedido) {
      if (item.produto.tipo === 'PRODUTO') {
        await prisma.produto.update({
          where: { id: item.produtoId },
          data: {
            quantidadeEstoque: { increment: item.quantidade },
          },
        });
        await prisma.movimentacaoEstoque.create({
          data: {
            produtoId: item.produto.id,
            tipo: 'ENTRADA',
            quantidade: item.quantidade,
            observacao: `Estorno de venda - Pedido ${id}`,
            empresaId,
          },
        });
      }
    }

    await prisma.itemPedido.deleteMany({ where: { pedidoId: id } });
    await prisma.pedido.delete({ where: { id, empresaId } });

    return NextResponse.json({ message: 'Pedido excluído com sucesso.' });
  } catch (error) {
    console.error('Erro ao deletar pedido:', error);
    return NextResponse.json({ message: 'Erro interno do servidor.' }, { status: 500 });
  }
}

