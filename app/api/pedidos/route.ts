import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import jwt from 'jsonwebtoken';
import { prisma } from '@/app/lib/prisma';
import { z } from 'zod';
import { StatusPedido, TipoItem } from '@prisma/client';

interface TokenPayload {
  empresaId: string;
  userId: string;
}

const itemPedidoSchema = z.object({
  produtoId: z.string().cuid().optional(),
  descricao: z.string().min(1, "A descrição do item é obrigatória."),
  quantidade: z.number().positive("A quantidade deve ser maior que zero."),
  precoUnitario: z.number().nonnegative("O preço não pode ser negativo."),
  tipo: z.nativeEnum(TipoItem)
});

const createPedidoSchema = z.object({
  numeroPedido: z.number().int().positive(),
  clienteId: z.string().cuid("ID de cliente inválido."),
  status: z.nativeEnum(StatusPedido),
  validadeOrcamento: z.string().optional(),
  dataEntrega: z.string().optional(),
  frete: z.number().nonnegative().optional(),
  informacoesNegociacao: z.string().optional(),
  observacoesNF: z.string().optional(),
  itens: z.array(itemPedidoSchema).min(1, "O pedido deve ter pelo menos um item."),
});

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const statusParam = searchParams.get('status');
    const status = statusParam ? StatusPedido[statusParam as keyof typeof StatusPedido] : null;
    const vendedorId = searchParams.get('vendedorId');
    const dataInicio = searchParams.get('dataInicio');
    const dataFim = searchParams.get('dataFim');

    const cookieStore = cookies();
    const token = cookieStore.get('auth-token')?.value;
    if (!token) return NextResponse.json({ message: 'Não autorizado' }, { status: 401 });

    const { empresaId } = jwt.verify(token, process.env.JWT_SECRET!) as TokenPayload;

    const whereClause: any = {
      empresaId: empresaId,
      ...(status && { status: status }),
      ...(vendedorId && { vendedorId: vendedorId }),
      ...(dataInicio && dataFim && { 
        dataPedido: { 
          gte: new Date(dataInicio), 
          lte: new Date(dataFim) 
        } 
      }),
    };

    const pedidos = await prisma.pedido.findMany({
      where: whereClause,
      include: {
        cliente: { select: { nome: true } },
        vendedor: { select: { nome: true } },
      },
      orderBy: { dataPedido: 'desc' },
    });

    return NextResponse.json(pedidos.map(p => ({...p, valorTotal: Number(p.valorTotal)})));
  } catch (error) {
    return NextResponse.json({ message: 'Erro ao buscar pedidos.' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const cookieStore = cookies();
    const token = cookieStore.get('auth-token')?.value;
    if (!token) return NextResponse.json({ message: 'Não autorizado' }, { status: 401 });

    const { empresaId, userId: vendedorId } = jwt.verify(token, process.env.JWT_SECRET!) as { empresaId: string; userId: string; };
    
    const body = await request.json();
    const validation = createPedidoSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json({ message: "Dados inválidos.", details: validation.error.flatten().fieldErrors }, { status: 400 });
    }
    
    const { 
      numeroPedido, 
      clienteId, 
      status, 
      validadeOrcamento, 
      dataEntrega, 
      frete, 
      informacoesNegociacao, 
      observacoesNF, 
      itens 
    } = validation.data;

    const novoPedido = await prisma.$transaction(async (tx) => {
      // Verificar se o número do pedido já existe
      const pedidoExistente = await tx.pedido.findUnique({
        where: { empresaId_numeroPedido: { empresaId, numeroPedido } },
      });

      if (pedidoExistente) {
        throw new Error(`Já existe um pedido com o número ${numeroPedido}`);
      }

      const valorTotal = itens.reduce((acc, item) => acc + (item.quantidade * item.precoUnitario), 0) + (frete || 0);

      const pedido = await tx.pedido.create({
        data: {
          empresaId,
          clienteId,
          vendedorId,
          status,
          numeroPedido,
          valorTotal,
          validadeOrcamento: validadeOrcamento ? new Date(validadeOrcamento) : null,
          dataEntrega: dataEntrega ? new Date(dataEntrega) : null,
          frete: frete || 0,
          informacoesNegociacao,
          observacoesNF,
        },
      });

      // Criar histórico inicial
      await tx.historicoPedido.create({
        data: {
          pedidoId: pedido.id,
          descricao: `Pedido criado com status: ${status}`,
          usuarioId: vendedorId,
        },
      });

      for (const item of itens) {
        await tx.itemPedido.create({
          data: {
            pedidoId: pedido.id,
            produtoId: item.produtoId,
            descricao: item.descricao,
            quantidade: item.quantidade,
            precoUnitario: item.precoUnitario,
          },
        });

        // Baixa no estoque apenas para produtos vendidos
        if (item.tipo === 'PRODUTO' && item.produtoId && status === 'VENDIDO') {
          await tx.produto.update({
            where: { id: item.produtoId },
            data: {
              quantidadeEstoque: {
                decrement: item.quantidade,
              },
            },
          });

          // Registrar movimentação de estoque
          await tx.movimentacaoEstoque.create({
            data: {
              produtoId: item.produtoId,
              tipo: 'SAIDA',
              quantidade: item.quantidade,
              observacao: `Venda - Pedido #${numeroPedido}`,
              empresaId,
            },
          });
        }
      }

      // Marcar cliente como recorrente se for primeira venda
      if (status === 'VENDIDO') {
        await tx.cliente.updateMany({
          where: { id: clienteId, primeiraCompraConcluida: false },
          data: { primeiraCompraConcluida: true },
        });
      }

      return pedido;
    });

    return NextResponse.json(novoPedido, { status: 201 });
  } catch (error) {
    console.error("Erro ao criar pedido:", error);
    return NextResponse.json({ 
      message: error instanceof Error ? error.message : 'Erro ao criar o pedido.' 
    }, { status: 500 });
  }
}

