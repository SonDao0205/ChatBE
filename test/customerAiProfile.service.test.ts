import {
  classifyLead,
  extractPreferences,
} from '../src/service/customerAiProfile.service';

function message(text: string, id = 'message-id') {
  return {
    id,
    text_content: text,
    sender_type: 'CUSTOMER',
    created_at: new Date(),
  };
}

describe('customer AI profile rules', () => {
  it('extracts explicit preferences without inventing values', () => {
    expect(extractPreferences([
      message('Tôi thích màu đen, form rộng và mặc size L, ưu tiên chất lượng.'),
    ])).toMatchObject({
      preferred_colors: ['đen'],
      preferred_sizes: ['L'],
      preferred_styles: ['form rộng'],
      purchase_priorities: ['Chất lượng'],
    });
  });

  it('classifies a purchase-ready customer as hot lead', () => {
    expect(classifyLead([
      message('Mẫu màu đen size L còn hàng không? Tôi muốn chốt và giao gấp.'),
    ], [])).toMatchObject({ code: 'HOT_LEAD' });
  });

  it('classifies research and comparison as warm lead', () => {
    expect(classifyLead([
      message('Hai mẫu này khác nhau thế nào và giá bao nhiêu?'),
    ], [])).toMatchObject({ code: 'WARM_LEAD' });
  });

  it('requires a verified completed order for existing priority', () => {
    const orders = [{
      id: 'order-1', canonical_status: 'DELIVERED', total_amount: '100000',
      product_id: 'product-1', product_name: 'Áo', variant_name: 'L',
    }];
    expect(classifyLead([message('Tôi muốn mua lại như lần trước.')], orders))
      .toMatchObject({ code: 'EXISTING_PRIORITY' });
  });
});
