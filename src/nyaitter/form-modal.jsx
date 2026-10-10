/* eslint-disable max-len, react/jsx-no-bind, react/jsx-no-literals, react/prop-types */
import React from 'react';
import styles from './form-modal.css';

const FormModal = ({title, fields, submitLabel, onCancel, onSubmit}) => {
    const [values, setValues] = React.useState(() => Object.fromEntries(fields.map(field => [field.name, field.value ?? ''])));
    const handleSubmit = event => {
        event.preventDefault();
        onSubmit(values);
    };
    return (
        <div className={styles.modalOverlay} onClick={onCancel} role="dialog">
            <div className={styles.modalContent} onClick={e => e.stopPropagation()}>
                <div className={styles.modalHeader}>
                    <span>{title}</span>
                    <button type="button" className={styles.closeButton} onClick={onCancel}>&times;</button>
                </div>
                <form className={styles.body} onSubmit={handleSubmit}>
                    {fields.filter(field => !field.visibleWhen || field.visibleWhen(values)).map(field => (
                        field.type === 'checkbox' ? (
                            <label key={field.name} className={styles.checkboxField}>
                                <input
                                    checked={Boolean(values[field.name])}
                                    disabled={field.disabled}
                                    type="checkbox"
                                    onChange={event => setValues({...values, [field.name]: event.target.checked})}
                                />
                                <span>{field.label}</span>
                            </label>
                        ) : (
                            <label key={field.name} className={styles.field}>
                                <span>{field.label}</span>
                                {field.type === 'select' ? (
                                    <select
                                        autoFocus={field.autoFocus}
                                        disabled={field.disabled}
                                        required={field.required !== false}
                                        value={values[field.name]}
                                        onChange={event => setValues({...values, [field.name]: event.target.value})}
                                    >
                                        {field.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                                    </select>
                                ) : (
                                    <input
                                        autoFocus={field.autoFocus}
                                        disabled={field.disabled}
                                        maxLength={field.maxLength}
                                        readOnly={field.readOnly}
                                        required={field.required !== false}
                                        type={field.type || 'text'}
                                        value={values[field.name]}
                                        onChange={event => setValues({...values, [field.name]: event.target.value})}
                                        onClick={field.readOnly ? e => e.target.select() : undefined}
                                    />
                                )}
                            </label>
                        )
                    ))}
                    <div className={styles.actions}>
                        <button className={styles.cancel} type="button" onClick={onCancel}>キャンセル</button>
                        <button className={styles.submit} type="submit">{submitLabel}</button>
                    </div>
                </form>
            </div>
        </div>
    );
};

export default FormModal;
